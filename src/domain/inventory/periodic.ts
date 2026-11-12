import { ACCOUNTS, type AccountCode } from "../ledger/accounts";
import type { JournalEntryDraft } from "../ledger/entry";
import { type Money, money, mulDiv, PESO, subtract, sum } from "../money";
import { InventoryError, MAX_AMOUNT_MINOR } from "./product";

// Inventario periódico (docs/sprint-6-productos-inventario.md). Funciones puras: arman los asientos y
// valoran el conteo. Todo el dinero pasa por money.ts; las cantidades son unidades enteras.
//
// - Compra: Dr 1435 / Cr 1105 (caja), 1110 (banco) o 3105 (carga inicial, aporte del dueño).
// - Conteo: cada producto vale unidades × costo unitario de su ÚLTIMA compra (amount/quantity de esa
//   línea), redondeado half-up una sola vez por línea con mulDiv. Sin compras, vale 0 y se marca.
// - Ajuste: saldo de 1435 − valor contado. > 0: Dr 6135 / Cr 1435; < 0: Dr 1435 / Cr 6135; 0: nada.
//   Así, después del conteo, 1435 es exactamente lo contado y 6135 del periodo es
//   inventario inicial + compras − inventario final.

export const PAID_FROM = ["cash", "bank", "owner"] as const;
export type PurchasePaidFrom = (typeof PAID_FROM)[number];

/** Líneas por documento y unidades por línea: topes sanos para una barbería. */
export const MAX_LINES = 60;
export const MAX_QUANTITY = 100_000;

export const PAID_FROM_LABELS: Record<PurchasePaidFrom, string> = {
  cash: "de la caja",
  bank: "del banco",
  owner: "como carga inicial (aporte del dueño)",
};

interface EntryMeta {
  readonly businessDate: string;
  readonly memo: string;
  readonly idempotencyKey?: string;
}

export interface PurchaseLine {
  readonly productId: bigint;
  /** Unidades compradas (enteras, > 0). */
  readonly quantity: number;
  /** Costo TOTAL de la línea, en pesos enteros (≥ 0). */
  readonly amount: Money;
}

function assertQuantity(quantity: number, min: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < min || quantity > MAX_QUANTITY) {
    throw new InventoryError(
      min > 0 ? `Las unidades deben ser un número entero entre 1 y ${MAX_QUANTITY}` : `Las unidades contadas deben ser un número entero entre 0 y ${MAX_QUANTITY}`,
    );
  }
}

function assertDistinctProducts(lines: readonly { productId: bigint }[]): void {
  const seen = new Set<bigint>();
  for (const l of lines) {
    if (seen.has(l.productId)) throw new InventoryError("Un producto aparece dos veces; junta sus unidades en una sola línea");
    seen.add(l.productId);
  }
}

/** Valida las líneas de una compra y devuelve su total (> 0, en pesos enteros). */
export function purchaseTotal(lines: readonly PurchaseLine[]): Money {
  if (lines.length === 0) throw new InventoryError("Agrega al menos un producto a la compra");
  if (lines.length > MAX_LINES) throw new InventoryError(`Una compra tiene a lo sumo ${MAX_LINES} productos`);
  assertDistinctProducts(lines);
  for (const l of lines) {
    assertQuantity(l.quantity, 1);
    if (l.amount.minor < 0n) throw new InventoryError("El costo de una línea no puede ser negativo");
    if (l.amount.minor % PESO !== 0n) throw new InventoryError("El costo debe ir en pesos enteros");
    if (l.amount.minor > MAX_AMOUNT_MINOR) throw new InventoryError("El costo de una línea es demasiado grande");
  }
  const total = sum(lines.map((l) => l.amount));
  if (total.minor <= 0n) throw new InventoryError("El total de la compra debe ser mayor que cero");
  if (total.minor > MAX_AMOUNT_MINOR) throw new InventoryError("El total de la compra es demasiado grande");
  return total;
}

/** Cuenta de donde sale el dinero de una compra. */
export function purchaseSource(paidFrom: PurchasePaidFrom): AccountCode {
  switch (paidFrom) {
    case "cash":
      return ACCOUNTS.cash.code;
    case "bank":
      return ACCOUNTS.bank.code;
    case "owner":
      return ACCOUNTS.ownerEquity.code;
  }
}

/** Asiento de una compra: la mercancía entra a 1435 contra la caja, el banco o el capital del dueño. */
export function purchaseEntry(input: { total: Money; paidFrom: PurchasePaidFrom }, meta: EntryMeta): JournalEntryDraft {
  if (input.total.minor <= 0n) throw new InventoryError("El total de la compra debe ser mayor que cero");
  return {
    ...meta,
    kind: "inventory_purchase",
    lines: [
      { account: ACCOUNTS.inventory.code, side: "debit", amount: input.total },
      { account: purchaseSource(input.paidFrom), side: "credit", amount: input.total },
    ],
  };
}

// ─── Conteo ──────────────────────────────────────────────────────────────────

/** La línea de la última compra de un producto: de ahí sale su costo unitario (amount / quantity). */
export interface LastPurchase {
  readonly quantity: number;
  readonly amount: Money;
}

export interface CountedLine {
  readonly productId: bigint;
  /** Unidades contadas (enteras, ≥ 0). */
  readonly quantity: number;
}

export interface ValuedLine extends CountedLine {
  /** unidades × costo unitario de la última compra, half-up al centavo una sola vez. */
  readonly value: Money;
  /** false: el producto no tiene compras; vale 0 y se le avisa al dueño. */
  readonly costKnown: boolean;
}

/** Valor de una línea del conteo. Sin compras (o con una compra de 0 unidades) vale 0 y se marca. */
export function valueCountLine(quantity: number, last: LastPurchase | null | undefined): { value: Money; costKnown: boolean } {
  assertQuantity(quantity, 0);
  if (!last || last.quantity <= 0) return { value: money(0n), costKnown: false };
  return { value: mulDiv(last.amount, BigInt(quantity), BigInt(last.quantity)), costKnown: true };
}

/** Valora un conteo completo: una línea por producto y el total (la suma exacta de las líneas). */
export function valueCount(lines: readonly CountedLine[], lastPurchases: ReadonlyMap<bigint, LastPurchase>): { lines: ValuedLine[]; total: Money } {
  if (lines.length > MAX_LINES * 10) throw new InventoryError("El conteo tiene demasiados productos");
  assertDistinctProducts(lines);
  const valued = lines.map((l) => ({ ...l, ...valueCountLine(l.quantity, lastPurchases.get(l.productId)) }));
  return { lines: valued, total: sum(valued.map((l) => l.value)) };
}

/** ¿Es el último día de su mes? El conteo se hace ese día (decisión del dueño). Fecha "yyyy-MM-dd". */
export function isLastDayOfMonth(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new InventoryError("Fecha inválida");
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // El día 0 del mes siguiente es el último de este (calendario, sin zona horaria).
  return day === new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ─── Unidades: esperado vs. contado (informativo, no asienta nada) ───────────

/** Lo que pasó con un producto entre dos conteos, en unidades enteras. */
export interface UnitMovement {
  /** Unidades del conteo anterior (0 si no hubo o el producto es nuevo). */
  readonly base: number;
  /** Unidades de las compras vigentes (no anuladas) del periodo. */
  readonly purchased: number;
  /** Unidades vendidas en el periodo, neto de las ventas anuladas en él. */
  readonly sold: number;
}

/**
 * Unidades que debería haber: conteo anterior + compras − ventas. Puede salir negativo (se vendió algo
 * cuya compra no se registró): se muestra tal cual, porque esconderlo taparía el error.
 */
export function expectedUnits(m: UnitMovement): number {
  return m.base + m.purchased - m.sold;
}

/** contado − esperado. Negativo: faltan unidades (consumo del local, pérdida o venta sin cobrar). */
export function unitDifference(counted: number, m: UnitMovement): number {
  return counted - expectedUnits(m);
}

/** Ajuste del conteo: saldo de 1435 − valor contado (positivo: costo de lo vendido y lo perdido). */
export function countAdjustment(bookBalance: Money, countedValue: Money): Money {
  return subtract(bookBalance, countedValue);
}

/** Asiento del ajuste del conteo, o null si el libro ya vale lo contado. */
export function countAdjustmentEntry(input: { bookBalance: Money; countedValue: Money }, meta: EntryMeta): JournalEntryDraft | null {
  if (input.countedValue.minor < 0n) throw new InventoryError("El valor contado no puede ser negativo");
  const adjustment = countAdjustment(input.bookBalance, input.countedValue);
  if (adjustment.minor === 0n) return null;
  const amount = money(adjustment.minor > 0n ? adjustment.minor : -adjustment.minor, adjustment.currency);
  const [debit, credit] = adjustment.minor > 0n ? [ACCOUNTS.costOfGoodsSold.code, ACCOUNTS.inventory.code] : [ACCOUNTS.inventory.code, ACCOUNTS.costOfGoodsSold.code];
  return {
    ...meta,
    kind: "inventory_count",
    lines: [
      { account: debit, side: "debit", amount },
      { account: credit, side: "credit", amount },
    ],
  };
}
