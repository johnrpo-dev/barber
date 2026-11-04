import { ACCOUNTS, type AccountCode } from "../ledger/accounts";
import type { JournalEntryDraft, LedgerLine } from "../ledger/entry";
import { add, type Money, money, negate, PESO, subtract, sum, truncateTo } from "../money";

// Liquidación de comisiones y anticipos (docs/sprint-5-comisiones-informes.md §1, §3 y §4).
// Funciones puras: calculan la liquidación desde lo que la base dice que está pendiente y arman el
// asiento. Nunca redondean comisiones (vienen congeladas en cada línea de venta). La base vuelve a
// verificar todo al hacer COMMIT (migración 0013).

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

export const MAX_ADJUSTMENTS = 10;
export const MAX_SETTLEMENT_REASON = 300;
export const MIN_SETTLEMENT_REASON = 3;
/** Tope sano por monto: $100.000 millones (igual que el cobro). */
const MAX_AMOUNT_MINOR = 10n ** 13n;

export type SettlementLineKind = "commission" | "clawback" | "tips" | "adjustment" | "advance_deduction" | "carry_over";
export type PaidFrom = "cash" | "bank";

export interface PendingCommission {
  readonly saleLineId: bigint;
  readonly businessDate: string;
  readonly commission: Money;
}
export interface PendingClawback {
  readonly saleLineId: bigint;
  readonly businessDate: string;
  readonly commission: Money;
}
export interface AdjustmentInput {
  readonly direction: "add" | "deduct";
  readonly amount: Money;
  readonly reason: string;
}

export interface SettlementInput {
  readonly commissions: readonly PendingCommission[];
  readonly clawbacks: readonly PendingClawback[];
  /** staff_tips_owed: puede ser negativo o tener centavos. */
  readonly tipsOwed: Money;
  readonly includeTips: boolean;
  /** staff_receivable (≥ 0). */
  readonly receivable: Money;
  /** "max" = min(receivable, max(G, 0)). */
  readonly advanceDeduction: Money | "max";
  readonly adjustments: readonly AdjustmentInput[];
}

export interface SettlementLineDraft {
  readonly kind: SettlementLineKind;
  readonly saleLineId?: bigint;
  /** Con signo: efecto sobre el pago. */
  readonly amount: Money;
  readonly reason?: string;
}

export interface SettlementDraft {
  readonly lines: readonly SettlementLineDraft[];
  readonly commissionTotal: Money; // C
  readonly clawbackTotal: Money; // V
  readonly tips: Money; // T, con signo, en pesos enteros
  readonly adjustmentsTotal: Money; // J, con signo
  readonly gross: Money; // G = C − V + T + J
  readonly advanceDeduction: Money; // D
  readonly carryOver: Money; // K
  readonly payout: Money; // P = G − D + K
}

const isWholePesos = (m: Money) => m.minor % PESO === 0n;

/** Motivo obligatorio, recortado, de 3 a 300 caracteres. `what`: "el motivo del ajuste". */
export function requireSettlementReason(text: string | undefined, what: string): string {
  const clean = text?.trim() ?? "";
  if (!clean) throw new SettlementError(`Escribe ${what}`);
  if (clean.length < MIN_SETTLEMENT_REASON) throw new SettlementError(`Escribe ${what} (mínimo ${MIN_SETTLEMENT_REASON} caracteres)`);
  if (clean.length > MAX_SETTLEMENT_REASON) throw new SettlementError(`${what[0]!.toUpperCase()}${what.slice(1)} es muy largo`);
  return clean;
}

/** Propinas que se liquidan: truncadas a pesos enteros (los centavos quedan pendientes). */
export function settledTips(owed: Money): Money {
  return truncateTo(owed, PESO);
}

/** "N.º 0012": número del comprobante (consecutivo por sede y serie). */
export function receiptNumberLabel(n: bigint): string {
  return `N.º ${n.toString().padStart(4, "0")}`;
}

/** Lanza SettlementError con mensaje para el usuario. Nunca redondea comisiones (ya vienen congeladas). */
export function computeSettlement(input: SettlementInput): SettlementDraft {
  const currency = input.tipsOwed.currency;
  const zero = money(0n, currency);
  for (const c of [...input.commissions, ...input.clawbacks]) {
    // Una comisión congelada es positiva y en pesos enteros (half-up al peso al cobrar, ADR-001).
    if (c.commission.minor <= 0n || !isWholePesos(c.commission) || c.commission.minor > MAX_AMOUNT_MINOR) {
      throw new SettlementError("Una comisión pendiente tiene un monto inválido");
    }
  }
  if (input.receivable.minor < 0n || !isWholePesos(input.receivable)) {
    throw new SettlementError("El saldo por cobrar de la persona es inválido");
  }
  if (input.adjustments.length > MAX_ADJUSTMENTS) throw new SettlementError(`Máximo ${MAX_ADJUSTMENTS} ajustes por liquidación`);

  const lines: SettlementLineDraft[] = [];
  for (const c of input.commissions) lines.push({ kind: "commission", saleLineId: c.saleLineId, amount: c.commission });
  for (const v of input.clawbacks) lines.push({ kind: "clawback", saleLineId: v.saleLineId, amount: negate(v.commission) });

  const commissionTotal = sum(input.commissions.map((c) => c.commission), currency);
  const clawbackTotal = sum(input.clawbacks.map((c) => c.commission), currency);

  // Propinas: todo lo debido en pesos enteros si se incluyen; si el saldo es negativo (propina pagada
  // de una venta anulada), se recupera siempre, aunque se desmarque la casilla.
  const tips = input.includeTips || input.tipsOwed.minor < 0n ? settledTips(input.tipsOwed) : zero;
  if (tips.minor !== 0n) lines.push({ kind: "tips", amount: tips });

  let adjustmentsTotal = zero;
  for (const a of input.adjustments) {
    const reason = requireSettlementReason(a.reason, "el motivo del ajuste");
    if (a.amount.minor <= 0n) throw new SettlementError("El valor del ajuste debe ser mayor que cero");
    if (!isWholePesos(a.amount)) throw new SettlementError("El ajuste debe ir en pesos enteros");
    if (a.amount.minor > MAX_AMOUNT_MINOR) throw new SettlementError("El ajuste es demasiado grande");
    const signed = a.direction === "add" ? a.amount : negate(a.amount);
    adjustmentsTotal = add(adjustmentsTotal, signed);
    lines.push({ kind: "adjustment", amount: signed, reason });
  }

  const gross = add(subtract(commissionTotal, clawbackTotal), add(tips, adjustmentsTotal));
  const positiveGross = gross.minor > 0n ? gross.minor : 0n;
  const maxDeduction = money(input.receivable.minor < positiveGross ? input.receivable.minor : positiveGross, currency);
  let advanceDeduction: Money;
  if (input.advanceDeduction === "max") {
    advanceDeduction = maxDeduction;
  } else {
    advanceDeduction = input.advanceDeduction;
    if (advanceDeduction.minor < 0n || !isWholePesos(advanceDeduction)) {
      throw new SettlementError("El descuento de anticipos debe ser un valor en pesos enteros, de cero en adelante");
    }
    if (advanceDeduction.minor > maxDeduction.minor) {
      throw new SettlementError("El descuento de anticipos supera lo que se puede descontar");
    }
  }

  const carryOver = gross.minor < 0n ? negate(gross) : zero;
  const payout = gross.minor < 0n ? zero : subtract(gross, advanceDeduction);
  if (advanceDeduction.minor > 0n) lines.push({ kind: "advance_deduction", amount: negate(advanceDeduction) });
  if (carryOver.minor > 0n) lines.push({ kind: "carry_over", amount: carryOver });

  if (lines.length === 0) throw new SettlementError("No hay nada que liquidar hasta esa fecha de corte");

  return { lines, commissionTotal, clawbackTotal, tips, adjustmentsTotal, gross, advanceDeduction, carryOver, payout };
}

/**
 * Neto estimado para mostrar: comisiones pendientes − anulaciones + propinas en pesos enteros −
 * todo lo que debe; nunca negativo. La cifra que se paga la da computeSettlement en la vista previa.
 */
export function estimatedPayout(input: { commission: Money; clawbacks: Money; tipsOwed: Money; receivable: Money }): Money {
  const net = subtract(add(subtract(input.commission, input.clawbacks), settledTips(input.tipsOwed)), input.receivable);
  return net.minor > 0n ? net : money(0n, net.currency);
}

interface EntryMeta {
  readonly businessDate: string;
  readonly memo: string;
  readonly idempotencyKey: string;
}

function push(lines: LedgerLine[], account: AccountCode, side: "debit" | "credit", minor: bigint, currency: Money["currency"], memo?: string) {
  if (minor === 0n) return;
  if (minor < 0n) throw new SettlementError("Un componente de la liquidación es negativo");
  lines.push({ account, side, amount: money(minor, currency), ...(memo ? { memo } : {}) });
}

/** Asiento commission_payout (§3.1). paidFrom null solo si payout = 0. */
export function settlementEntry(draft: SettlementDraft, meta: EntryMeta & { paidFrom: PaidFrom | null }): JournalEntryDraft {
  if ((meta.paidFrom === null) !== (draft.payout.minor === 0n)) {
    throw new SettlementError(meta.paidFrom === null ? "Elige de dónde sale el pago" : "Un pago de $0 no mueve dinero");
  }
  const currency = draft.payout.currency;
  const bonuses = draft.lines.filter((l) => l.kind === "adjustment" && l.amount.minor > 0n).reduce((a, l) => a + l.amount.minor, 0n);
  const deductions = draft.lines.filter((l) => l.kind === "adjustment" && l.amount.minor < 0n).reduce((a, l) => a - l.amount.minor, 0n);
  const lines: LedgerLine[] = [];
  push(lines, ACCOUNTS.commissionsPayable.code, "debit", draft.commissionTotal.minor, currency);
  push(lines, ACCOUNTS.commissionsPayable.code, "credit", draft.clawbackTotal.minor, currency, "Anulación de una venta ya liquidada");
  if (draft.tips.minor > 0n) push(lines, ACCOUNTS.tipsPayable.code, "debit", draft.tips.minor, currency);
  if (draft.tips.minor < 0n) push(lines, ACCOUNTS.tipsPayable.code, "credit", -draft.tips.minor, currency, "Propinas recuperadas");
  // Bonos y descuentos en líneas separadas: nunca se compensan entre sí en el asiento.
  push(lines, ACCOUNTS.commissionExpense.code, "debit", bonuses, currency, "Ajustes a favor");
  push(lines, ACCOUNTS.commissionExpense.code, "credit", deductions, currency, "Ajustes en contra");
  push(lines, ACCOUNTS.staffReceivable.code, "credit", draft.advanceDeduction.minor, currency, "Anticipos descontados");
  push(lines, ACCOUNTS.staffReceivable.code, "debit", draft.carryOver.minor, currency, "Queda debiendo");
  if (meta.paidFrom) push(lines, meta.paidFrom === "cash" ? ACCOUNTS.cash.code : ACCOUNTS.bank.code, "credit", draft.payout.minor, currency);
  return { businessDate: meta.businessDate, kind: "commission_payout", memo: meta.memo, lines, idempotencyKey: meta.idempotencyKey };
}

/** Asiento staff_advance (§3.2). */
export function staffAdvanceEntry(amount: Money, paidFrom: PaidFrom, meta: EntryMeta): JournalEntryDraft {
  if (amount.minor <= 0n) throw new SettlementError("El anticipo debe ser mayor que cero");
  if (!isWholePesos(amount)) throw new SettlementError("El anticipo debe ir en pesos enteros");
  if (amount.minor > MAX_AMOUNT_MINOR) throw new SettlementError("El anticipo es demasiado grande");
  return {
    businessDate: meta.businessDate,
    kind: "staff_advance",
    memo: meta.memo,
    idempotencyKey: meta.idempotencyKey,
    lines: [
      { account: ACCOUNTS.staffReceivable.code, side: "debit", amount },
      { account: paidFrom === "cash" ? ACCOUNTS.cash.code : ACCOUNTS.bank.code, side: "credit", amount },
    ],
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Corte: no futuro, no anterior al último corte vigente. */
export function assertCutoff(input: { cutoffDate: string; today: string; lastCutoffDate: string | null }): void {
  if (!DATE.test(input.cutoffDate)) throw new SettlementError("Fecha de corte inválida");
  if (input.cutoffDate > input.today) throw new SettlementError("La fecha de corte no puede ser futura");
  if (input.lastCutoffDate !== null && input.cutoffDate < input.lastCutoffDate) {
    throw new SettlementError(`La fecha de corte no puede ser anterior a la última liquidación (${input.lastCutoffDate})`);
  }
}

/** Solo la última liquidación vigente de la persona. */
export function assertReversible(input: {
  status: "settled" | "reversed";
  number: bigint;
  latestActiveNumber: bigint | null;
  staffName?: string;
}): void {
  if (input.status === "reversed") throw new SettlementError("Esta liquidación ya está revertida");
  if (input.latestActiveNumber !== input.number) {
    const who = input.staffName ?? "esta persona";
    const latest = input.latestActiveNumber === null ? "" : ` (${receiptNumberLabel(input.latestActiveNumber)})`;
    throw new SettlementError(`Solo se puede revertir la última liquidación de ${who}${latest}. Revierte primero las más recientes.`);
  }
}
