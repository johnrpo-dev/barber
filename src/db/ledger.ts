import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { ACCOUNTS, type AccountCode, CHART_OF_ACCOUNTS } from "@/domain/ledger/accounts";
import { assertValidEntry, type JournalEntryDraft, type LedgerLine, reversalOf } from "@/domain/ledger/entry";
import { type Currency, money } from "@/domain/money";
import { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_PAYMENT_METHODS } from "@/domain/sales/defaults";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import { accounts, dayCloseEvents, expenseCategories, journalEntries, journalLines, locations, paymentMethods } from "./schema";
import { sumAsBigint } from "./sql";
import type { Db } from "./types";

// Servicio del libro mayor. Todo pasa por aquí: valida en el dominio y la base de datos
// vuelve a verificar al hacer COMMIT (migración ledger_guards).

/** Transacción serializable para flujos compuestos (cobro + caja + comisión). */
export function ledgerTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx as unknown as Db), { isolationLevel: "serializable" });
}

export async function createLocation(
  db: Db,
  input: { name: string; timezone?: string; currency?: Currency },
): Promise<bigint> {
  return db.transaction(async (tx) => {
    const [location] = await tx
      .insert(locations)
      .values({ name: input.name, timezone: input.timezone, currency: input.currency })
      .returning({ id: locations.id });
    if (!location) throw new Error("No se pudo crear la sede");
    await tx.insert(accounts).values(CHART_OF_ACCOUNTS.map((a) => ({ locationId: location.id, ...a })));
    // Medios de pago y categorías de gasto iniciales (sprint 4): sugerencias que el dueño edita.
    await tx.insert(paymentMethods).values(DEFAULT_PAYMENT_METHODS.map((m) => ({ locationId: location.id, ...m })));
    await tx.insert(expenseCategories).values(DEFAULT_EXPENSE_CATEGORIES.map((c) => ({ locationId: location.id, ...c })));
    return location.id;
  });
}

export interface PostEntryInput {
  locationId: bigint;
  entry: JournalEntryDraft;
  createdBy: string;
}

export interface PostedEntry {
  entryId: bigint;
  /** false si ya existía un asiento con la misma clave de idempotencia. */
  created: boolean;
}

async function accountIdsByCode(db: Db, locationId: bigint, codes: readonly AccountCode[]) {
  const rows = await db
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(and(eq(accounts.locationId, locationId), inArray(accounts.code, [...new Set(codes)])));
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  for (const code of codes) {
    if (!byCode.has(code)) throw new Error(`La cuenta ${code} no existe en la sede ${locationId}`);
  }
  return byCode;
}

async function insertEntry(
  db: Db,
  input: PostEntryInput & { reversesEntryId?: bigint },
): Promise<PostedEntry> {
  const { locationId, entry, createdBy } = input;
  assertValidEntry(entry);
  // Huella del asiento: la misma clave de idempotencia con otro contenido es un conflicto,
  // nunca se devuelve en silencio un asiento que no corresponde a esta petición.
  const hash = entry.idempotencyKey
    ? requestHash({
        locationId,
        businessDate: entry.businessDate,
        kind: entry.kind,
        memo: entry.memo,
        reversesEntryId: input.reversesEntryId ?? null,
        createdBy,
        lines: entry.lines.map((l) => ({
          account: l.account,
          side: l.side,
          minor: l.amount.minor,
          currency: l.amount.currency,
          memo: l.memo ?? null,
        })),
      })
    : null;

  return db.transaction(async (tx) => {
    const ids = await accountIdsByCode(tx as unknown as Db, locationId, entry.lines.map((l) => l.account));

    const inserted = await tx
      .insert(journalEntries)
      .values({
        locationId,
        businessDate: entry.businessDate,
        kind: entry.kind,
        memo: entry.memo,
        currency: entry.lines[0]!.amount.currency,
        idempotencyKey: entry.idempotencyKey,
        requestHash: hash,
        reversesEntryId: input.reversesEntryId,
        createdBy,
      })
      .onConflictDoNothing({ target: [journalEntries.locationId, journalEntries.idempotencyKey] })
      .returning({ id: journalEntries.id });

    const created = inserted[0];
    if (!created) {
      const [existing] = await tx
        .select({ id: journalEntries.id, requestHash: journalEntries.requestHash })
        .from(journalEntries)
        .where(and(eq(journalEntries.locationId, locationId), eq(journalEntries.idempotencyKey, entry.idempotencyKey!)));
      assertSameRequest(existing!, hash!);
      return { entryId: existing!.id, created: false };
    }

    await tx.insert(journalLines).values(
      entry.lines.map((line) => ({
        locationId,
        entryId: created.id,
        accountId: ids.get(line.account)!,
        debit: line.side === "debit" ? line.amount.minor : 0n,
        credit: line.side === "credit" ? line.amount.minor : 0n,
        memo: line.memo,
      })),
    );
    return { entryId: created.id, created: true };
  });
}

/** Registra un asiento. Si trae clave de idempotencia y ya existe, devuelve el existente. */
export function postEntry(db: Db, input: PostEntryInput): Promise<PostedEntry> {
  if (input.entry.kind === "reversal") {
    throw new Error("Las reversas se registran con reverseEntry()");
  }
  return insertEntry(db, input);
}

/** Anula un asiento con su espejo exacto, registrado en el día contable indicado. */
export async function reverseEntry(
  db: Db,
  input: { locationId: bigint; entryId: bigint; businessDate: string; reason: string; createdBy: string },
): Promise<PostedEntry> {
  const [original] = await db
    .select({ memo: journalEntries.memo, currency: journalEntries.currency })
    .from(journalEntries)
    .where(and(eq(journalEntries.locationId, input.locationId), eq(journalEntries.id, input.entryId)));
  if (!original) throw new Error(`El asiento ${input.entryId} no existe en la sede ${input.locationId}`);

  const rows = await db
    .select({ code: accounts.code, debit: journalLines.debit, credit: journalLines.credit, memo: journalLines.memo })
    .from(journalLines)
    .innerJoin(accounts, and(eq(accounts.id, journalLines.accountId), eq(accounts.locationId, journalLines.locationId)))
    .where(eq(journalLines.entryId, input.entryId))
    .orderBy(asc(journalLines.id));

  const currency = original.currency as Currency;
  const lines: LedgerLine[] = rows.map((r) => ({
    account: r.code as AccountCode,
    side: r.debit > 0n ? "debit" : "credit",
    amount: money(r.debit > 0n ? r.debit : r.credit, currency),
    memo: r.memo ?? undefined,
  }));

  return insertEntry(db, {
    locationId: input.locationId,
    createdBy: input.createdBy,
    reversesEntryId: input.entryId,
    entry: reversalOf({ lines, memo: original.memo }, input.businessDate, input.reason),
  });
}

/** ¿Está cerrado el día contable? Misma regla que el trigger del libro (ledger_day_is_closed). */
export async function isDayClosed(db: Db, locationId: bigint, businessDate: string): Promise<boolean> {
  const [row] = await db
    .select({ closed: sql<boolean>`ledger_day_is_closed(${locationId}::bigint, ${businessDate}::date)` })
    .from(locations)
    .where(eq(locations.id, locationId));
  return row?.closed === true;
}

/** Saldo (débitos − créditos) de una cuenta de la sede, sumado en SQL. */
export async function accountBalance(db: Db, locationId: bigint, code: AccountCode): Promise<bigint> {
  const [row] = await db
    .select({ debits: sumAsBigint(journalLines.debit), credits: sumAsBigint(journalLines.credit) })
    .from(journalLines)
    .innerJoin(accounts, and(eq(accounts.id, journalLines.accountId), eq(accounts.locationId, journalLines.locationId)))
    .where(and(eq(journalLines.locationId, locationId), eq(accounts.code, code)));
  return (row?.debits ?? 0n) - (row?.credits ?? 0n);
}

export async function closeDay(db: Db, input: { locationId: bigint; businessDate: string; createdBy: string }) {
  await db.insert(dayCloseEvents).values({ ...input, action: "close" });
}

export async function reopenDay(
  db: Db,
  input: { locationId: bigint; businessDate: string; reason: string; createdBy: string },
) {
  await db.insert(dayCloseEvents).values({ ...input, action: "reopen" });
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  debits: bigint;
  credits: bigint;
}

/** Balance de comprobación: total de débitos y créditos por cuenta en un rango de días contables. */
export async function trialBalance(
  db: Db,
  input: { locationId: bigint; from?: string; to?: string },
): Promise<TrialBalanceRow[]> {
  const conditions = [eq(journalLines.locationId, input.locationId)];
  if (input.from) conditions.push(gte(journalEntries.businessDate, input.from));
  if (input.to) conditions.push(lte(journalEntries.businessDate, input.to));

  return db
    .select({
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      debits: sumAsBigint(journalLines.debit),
      credits: sumAsBigint(journalLines.credit),
    })
    .from(journalLines)
    .innerJoin(
      journalEntries,
      and(eq(journalEntries.id, journalLines.entryId), eq(journalEntries.locationId, journalLines.locationId)),
    )
    .innerJoin(accounts, and(eq(accounts.id, journalLines.accountId), eq(accounts.locationId, journalLines.locationId)))
    .where(and(...conditions))
    .groupBy(accounts.code, accounts.name, accounts.type)
    .orderBy(asc(accounts.code));
}

export { ACCOUNTS };
