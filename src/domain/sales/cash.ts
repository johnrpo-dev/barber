import { ACCOUNTS, type AccountCode, CHART_OF_ACCOUNTS } from "../ledger/accounts";
import type { JournalEntryDraft } from "../ledger/entry";
import { type Money, money, subtract } from "../money";

// Movimientos de caja y gastos (docs/sprint-4-cobro-caja.md §3 y §4). Funciones puras que arman
// el asiento de cada operación. El efectivo esperado sale de SQL (saldo de 1105), no de aquí.

export class CashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CashError";
  }
}

interface EntryMeta {
  readonly businessDate: string;
  readonly memo: string;
  readonly idempotencyKey?: string;
}

function positive(amount: Money, what: string) {
  if (amount.minor <= 0n) throw new CashError(`${what} debe ser mayor que cero`);
}

function requireNote(note: string | undefined, what: string): string {
  const clean = note?.trim();
  if (!clean) throw new CashError(`Escribe una nota que explique ${what}`);
  return clean;
}

// Cuentas de gasto que tienen su propio flujo: no se cargan desde un gasto manual.
const RESERVED_EXPENSE_ACCOUNTS: ReadonlySet<string> = new Set([
  ACCOUNTS.commissionExpense.code,
  ACCOUNTS.cardFees.code,
  ACCOUNTS.cashDifferences.code,
]);

/** ¿Puede una categoría de gasto apuntar a esta cuenta? Solo cuentas de gasto sin flujo propio. */
export function isExpenseCategoryAccount(code: string): code is AccountCode {
  const account = CHART_OF_ACCOUNTS.find((a) => a.code === code);
  return account?.type === "expense" && !RESERVED_EXPENSE_ACCOUNTS.has(code);
}

/** Gasto pagado desde la caja o desde el banco, cargado a la cuenta de su categoría. */
export function expenseEntry(
  input: { amount: Money; expenseAccount: string; paidFrom: "cash" | "bank" },
  meta: EntryMeta,
): JournalEntryDraft {
  positive(input.amount, "El gasto");
  if (!isExpenseCategoryAccount(input.expenseAccount)) {
    throw new CashError("La categoría del gasto apunta a una cuenta que no es de gasto");
  }
  const source = input.paidFrom === "cash" ? ACCOUNTS.cash.code : ACCOUNTS.bank.code;
  return {
    ...meta,
    kind: "expense",
    lines: [
      { account: input.expenseAccount, side: "debit", amount: input.amount },
      { account: source, side: "credit", amount: input.amount },
    ],
  };
}

/** Pago de propinas en efectivo a un barbero: baja la deuda con él y sale de la caja. */
export function tipPayoutEntry(amount: Money, meta: EntryMeta): JournalEntryDraft {
  positive(amount, "El pago de propinas");
  return {
    ...meta,
    kind: "tip_payout",
    lines: [
      { account: ACCOUNTS.tipsPayable.code, side: "debit", amount },
      { account: ACCOUNTS.cash.code, side: "credit", amount },
    ],
  };
}

/** Consignación: el efectivo sale de la caja y entra al banco. */
export function cashDepositEntry(amount: Money, meta: EntryMeta): JournalEntryDraft {
  positive(amount, "La consignación");
  return {
    ...meta,
    kind: "cash_deposit",
    lines: [
      { account: ACCOUNTS.bank.code, side: "debit", amount },
      { account: ACCOUNTS.cash.code, side: "credit", amount },
    ],
  };
}

export interface CashCount {
  readonly expected: Money;
  readonly counted: Money;
  /** contado − esperado: positivo es sobrante, negativo es faltante. */
  readonly difference: Money;
}

export function countCash(expected: Money, counted: Money): CashCount {
  if (counted.minor < 0n) throw new CashError("El efectivo contado no puede ser negativo");
  return { expected, counted, difference: subtract(counted, expected) };
}

/**
 * Ajuste por diferencia al contar la caja (al abrir o al cerrar). Sin diferencia no hay asiento.
 * Con diferencia, la nota es obligatoria: un faltante o sobrante nunca se registra sin explicación.
 * La diferencia se calcula aquí, nunca se recibe hecha.
 */
export function cashAdjustmentEntry(
  input: { expected: Money; counted: Money },
  note: string | undefined,
  meta: EntryMeta,
): JournalEntryDraft | null {
  const count = countCash(input.expected, input.counted);
  const diff = count.difference.minor;
  if (diff === 0n) return null;
  const reason = requireNote(note, diff < 0n ? "el faltante" : "el sobrante");
  const amount = money(diff < 0n ? -diff : diff, count.difference.currency);
  const [debit, credit] = diff < 0n ? [ACCOUNTS.cashDifferences.code, ACCOUNTS.cash.code] : [ACCOUNTS.cash.code, ACCOUNTS.cashDifferences.code];
  return {
    ...meta,
    memo: `${meta.memo}: ${reason}`,
    kind: "cash_adjustment",
    lines: [
      { account: debit, side: "debit", amount },
      { account: credit, side: "credit", amount },
    ],
  };
}

/** Umbral por defecto para revisar un cierre: $20.000 (se ajusta en Ajustes). */
export const DEFAULT_CASH_REVIEW_THRESHOLD: Money = money(2_000_000n);

/**
 * ¿Un cierre con esta diferencia (contado − esperado) queda para revisión del dueño? Sí cuando el
 * faltante o el sobrante supera el umbral de la sede (docs/sprint-4-cobro-caja.md §9.2). La base
 * calcula lo mismo en el trigger de cierre (0011); este es el espejo para la interfaz y las pruebas.
 */
export function needsCashReview(difference: Money, threshold: Money): boolean {
  if (threshold.minor < 0n) throw new CashError("El umbral de revisión no puede ser negativo");
  const size = difference.minor < 0n ? -difference.minor : difference.minor;
  return size > threshold.minor;
}
