import { type Currency, type Money, money } from "../money";
import type { AccountCode } from "./accounts";

export type Side = "debit" | "credit";

export interface LedgerLine {
  readonly account: AccountCode;
  readonly side: Side;
  /** Siempre positivo: el lado indica la dirección. */
  readonly amount: Money;
  readonly memo?: string;
}

export const ENTRY_KINDS = [
  "sale",
  "expense",
  "commission_payout",
  "tip_payout",
  "cash_adjustment",
  "owner_contribution",
  "owner_withdrawal",
  "reversal",
] as const;

export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface JournalEntryDraft {
  /** Día contable local de la sede, YYYY-MM-DD. */
  readonly businessDate: string;
  readonly kind: EntryKind;
  readonly memo: string;
  readonly lines: readonly LedgerLine[];
  /** Mismo valor = mismo asiento: un doble toque no registra dos veces. */
  readonly idempotencyKey?: string;
}

export class UnbalancedEntryError extends Error {
  constructor(
    readonly debits: bigint,
    readonly credits: bigint,
  ) {
    super(`El asiento no cuadra: débitos ${debits} ≠ créditos ${credits} (centavos)`);
    this.name = "UnbalancedEntryError";
  }
}

export class InvalidEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEntryError";
  }
}

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function totals(lines: readonly LedgerLine[]): { debits: bigint; credits: bigint } {
  let debits = 0n;
  let credits = 0n;
  for (const line of lines) {
    if (line.side === "debit") debits += line.amount.minor;
    else credits += line.amount.minor;
  }
  return { debits, credits };
}

/**
 * Verifica las reglas de partida doble antes de tocar la base de datos.
 * La base de datos vuelve a verificar el cuadre al hacer COMMIT (defensa en profundidad).
 */
export function assertValidEntry(entry: JournalEntryDraft): void {
  if (!BUSINESS_DATE.test(entry.businessDate)) {
    throw new InvalidEntryError(`Día contable inválido: ${entry.businessDate}`);
  }
  if (entry.lines.length < 2) {
    throw new InvalidEntryError("Un asiento necesita al menos dos líneas");
  }
  const currency: Currency | undefined = entry.lines[0]?.amount.currency;
  for (const line of entry.lines) {
    if (line.amount.minor <= 0n) {
      throw new InvalidEntryError(`Monto no positivo en la cuenta ${line.account}`);
    }
    if (line.amount.currency !== currency) {
      throw new InvalidEntryError("Un asiento no puede mezclar monedas");
    }
  }
  const { debits, credits } = totals(entry.lines);
  if (debits !== credits) throw new UnbalancedEntryError(debits, credits);
}

/** Asiento espejo que anula a otro: mismas cuentas y montos, lados invertidos. */
export function reversalOf(
  original: Pick<JournalEntryDraft, "lines" | "memo">,
  businessDate: string,
  reason: string,
): JournalEntryDraft {
  return {
    businessDate,
    kind: "reversal",
    memo: `Reversa: ${reason} (original: ${original.memo})`,
    lines: original.lines.map((line) => ({
      ...line,
      side: line.side === "debit" ? "credit" : "debit",
    })),
  };
}

/** Saldo neto por cuenta (débitos − créditos), en centavos. */
export function netByAccount(lines: readonly LedgerLine[]): Map<AccountCode, Money> {
  const net = new Map<AccountCode, Money>();
  for (const line of lines) {
    const signed = line.side === "debit" ? line.amount.minor : -line.amount.minor;
    const previous = net.get(line.account)?.minor ?? 0n;
    net.set(line.account, money(previous + signed, line.amount.currency));
  }
  return net;
}
