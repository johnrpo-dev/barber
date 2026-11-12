import { ACCOUNTS, type AccountCode } from "../ledger/accounts";
import type { JournalEntryDraft } from "../ledger/entry";
import { type Money, PESO, subtract } from "../money";
import { InventoryError, MAX_AMOUNT_MINOR } from "./product";

// Cuentas por pagar a proveedores (sprint 8, parte A; docs/sprint-8-gastos-controles.md §5b). Funciones
// puras: el saldo de una compra a crédito, el tope de un pago, el vencimiento y el asiento del pago.
//
// - Compra a crédito: Dr 1435 / Cr 2205 (purchaseEntry con paidFrom "credit", en periodic.ts).
// - Pago: Dr 2205 / Cr 1105 (caja), 1110 (banco) o 3105 (de su bolsillo: aporte del dueño).
// Un pago es de UNA compra, puede ser parcial y nunca supera lo que se debe de ella.

export const SUPPLIER_PAID_FROM = ["cash", "bank", "owner"] as const;
export type SupplierPaidFrom = (typeof SUPPLIER_PAID_FROM)[number];

export const SUPPLIER_PAID_FROM_LABELS: Record<SupplierPaidFrom, string> = {
  cash: "de la caja",
  bank: "del banco",
  owner: "de su bolsillo (aporte del dueño)",
};

/** Plazo de una compra a crédito, en días (0 = vence el mismo día). */
export const DEFAULT_TERM_DAYS = 30;
export const MAX_TERM_DAYS = 180;
/** "Por vencer": lo que vence en estos días o menos se avisa en Inicio. */
export const DUE_SOON_DAYS = 3;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Controles (C0 y C1) e invisibles de formato (U+200B y similares): partirían un proveedor en dos nombres. */
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const DAY_MS = 86_400_000;

function parseDate(date: string): number {
  const m = DATE.exec(date);
  if (!m) throw new InventoryError("Fecha inválida");
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Rechaza fechas que no existen (2026-02-30): el calendario las movería a otro día.
  if (new Date(t).toISOString().slice(0, 10) !== date) throw new InventoryError("Fecha inválida");
  return t;
}

/** Vencimiento: el día de la compra más el plazo, en días de calendario (sin zona horaria). */
export function dueDateFor(businessDate: string, termDays: number): string {
  if (!Number.isSafeInteger(termDays) || termDays < 0 || termDays > MAX_TERM_DAYS) {
    throw new InventoryError(`El plazo debe ser un número entero de días entre 0 y ${MAX_TERM_DAYS}`);
  }
  return new Date(parseDate(businessDate) + termDays * DAY_MS).toISOString().slice(0, 10);
}

/** Días de calendario de `from` a `to` (negativo si `to` es anterior). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

export type DueState = "overdue" | "today" | "soon" | "later";

export interface DueStatus {
  state: DueState;
  /** Días que faltan (positivo) o que lleva vencida (negativo). */
  days: number;
  label: string;
}

/** Estado del vencimiento de una deuda vista desde `today` (día contable local de la sede). */
export function dueStatus(dueDate: string, today: string): DueStatus {
  const days = daysBetween(today, dueDate);
  if (days < 0) return { state: "overdue", days, label: `Vencida hace ${-days} ${-days === 1 ? "día" : "días"}` };
  if (days === 0) return { state: "today", days, label: "Vence hoy" };
  return { state: days <= DUE_SOON_DAYS ? "soon" : "later", days, label: `Vence en ${days} ${days === 1 ? "día" : "días"}` };
}

/** Lo que falta por pagar de una compra: total − pagos vigentes. Nunca negativo (la base lo exige). */
export function outstanding(total: Money, paid: Money): Money {
  const rest = subtract(total, paid);
  if (rest.minor < 0n) throw new InventoryError("Los pagos superan el total de la compra");
  return rest;
}

/** Valida un pago contra lo que se debe de esa compra. */
export function assertPayment(amount: Money, owed: Money): void {
  if (amount.minor <= 0n) throw new InventoryError("El pago debe ser mayor que cero");
  if (amount.minor % PESO !== 0n) throw new InventoryError("El pago debe ir en pesos enteros");
  if (amount.minor > MAX_AMOUNT_MINOR) throw new InventoryError("El pago es demasiado grande");
  if (owed.minor <= 0n) throw new InventoryError("Esta compra ya está pagada");
  if (amount.minor > owed.minor) throw new InventoryError("El pago es mayor que lo que se debe de esta compra");
}

/** Cuenta de donde sale el dinero de un pago a proveedor. */
export function supplierPaymentSource(paidFrom: SupplierPaidFrom): AccountCode {
  switch (paidFrom) {
    case "cash":
      return ACCOUNTS.cash.code;
    case "bank":
      return ACCOUNTS.bank.code;
    case "owner":
      return ACCOUNTS.ownerEquity.code;
  }
}

/** Asiento del pago: baja la deuda con el proveedor (2205) contra la caja, el banco o el capital del dueño. */
export function supplierPaymentEntry(
  input: { amount: Money; paidFrom: SupplierPaidFrom },
  meta: { businessDate: string; memo: string; idempotencyKey?: string },
): JournalEntryDraft {
  if (input.amount.minor <= 0n) throw new InventoryError("El pago debe ser mayor que cero");
  return {
    ...meta,
    kind: "supplier_payment",
    lines: [
      { account: ACCOUNTS.accountsPayable.code, side: "debit", amount: input.amount },
      { account: supplierPaymentSource(input.paidFrom), side: "credit", amount: input.amount },
    ],
  };
}

/** Nombre del proveedor limpio (sin espacios de más); la base exige lo mismo con CHECK. */
export function cleanSupplierName(name: string): string {
  // NFC: "José" escrito con la tilde aparte y con la letra ya acentuada es el mismo proveedor.
  const normalized = name.normalize("NFC");
  if (CONTROL.test(normalized)) throw new InventoryError("El nombre del proveedor tiene caracteres no permitidos");
  const clean = normalized.trim().replace(/\s+/g, " ");
  if (clean.length < 2 || clean.length > 80) throw new InventoryError("El nombre del proveedor debe tener entre 2 y 80 caracteres");
  return clean;
}
