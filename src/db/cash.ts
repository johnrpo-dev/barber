import { and, asc, desc, eq, gte, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { cashAdjustmentEntry, cashDepositEntry, CashError, tipPayoutEntry } from "@/domain/sales/cash";
import { format, type Money, money } from "@/domain/money";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import { can, type Role } from "@/domain/staff/roles";
import { accountBalance, closeDay, isDayClosed, postEntry, reopenDay } from "./ledger";
import {
  accounts,
  cashMovements,
  cashSessions,
  clients,
  journalEntries,
  journalLines,
  locations,
  salePayments,
  sales,
  staffMembers,
  voidRequests,
} from "./schema";
import { listExpenseCategories } from "./checkout-settings";
import { serializable } from "./serializable";
import { sumAsBigint } from "./sql";
import type { Db } from "./types";

// Caja (docs/sprint-4-cobro-caja.md §3–§5). Cada operación corre en una transacción SERIALIZABLE
// con reintento, con su clave de idempotencia ligada al contenido, y registra su asiento en la
// misma transacción. El efectivo esperado es SIEMPRE el saldo de 1105 en el libro (SQL): al abrir,
// el ajuste de apertura deja el libro igual a lo contado; durante el turno, toda operación que toca
// 1105 exige la caja abierta (bloqueada FOR UPDATE) y queda como movimiento del turno.

export interface ActorRef {
  userId: string;
  /** Con su rol, el mensaje de "no hay tanto efectivo" puede ser exacto (solo con cash.review). */
  role?: Role;
}

/** Mensaje para quien cuenta a ciegas: no dice cuánto efectivo hay ni da una cota (LOW-4). */
export const BLIND_CASH_SHORT = "Ese monto no se puede sacar de la caja ahora. Revisa el valor o pídele al dueño que lo registre.";

/**
 * Sacar más efectivo del que dice el libro. Con la caja a ciegas, "No hay tanto efectivo" le diría a
 * quien cuenta que el esperado es menor que el monto: solo quien tiene cash.review lo recibe así.
 * (El rechazo mismo sigue diciendo "no alcanza"; eso no se puede evitar sin dejar sacar de más.)
 */
export function cashShortError(actor: ActorRef): CashError {
  return new CashError(actor.role !== undefined && can(actor.role, "cash.review") ? "No hay tanto efectivo en la caja" : BLIND_CASH_SHORT);
}

async function locationTimeZone(db: Db, locationId: bigint): Promise<string> {
  const [row] = await db.select({ tz: locations.timezone }).from(locations).where(eq(locations.id, locationId));
  if (!row) throw new Error(`La sede ${locationId} no existe`);
  return row.tz;
}

/** Día contable de hoy en la sede y si está cerrado. */
export async function today(db: Db, locationId: bigint, now: Date = new Date()): Promise<{ businessDate: string; closed: boolean; timeZone: string }> {
  const timeZone = await locationTimeZone(db, locationId);
  const day = businessDate(now, timeZone);
  return { businessDate: day, closed: await isDayClosed(db, locationId, day), timeZone };
}

/** Día abierto para registrar, o error con el mensaje del contrato. */
export async function requireOpenDay(db: Db, locationId: bigint, now: Date, error: (msg: string) => Error): Promise<string> {
  const day = await today(db, locationId, now);
  if (day.closed) throw error(`El día ya está cerrado (${day.businessDate}). El dueño debe reabrirlo para registrar movimientos.`);
  return day.businessDate;
}

/** Efectivo según el libro: saldo de 1105, sumado en SQL. */
export function ledgerCash(db: Db, locationId: bigint): Promise<bigint> {
  return accountBalance(db, locationId, ACCOUNTS.cash.code);
}

const sessionColumns = {
  id: cashSessions.id,
  openedBy: cashSessions.openedBy,
  openedAt: cashSessions.openedAt,
  openingCounted: cashSessions.openingCounted,
};

/** La caja abierta de la sede. `lock`: la toma FOR UPDATE (cobro en efectivo, gastos, cierre). */
export async function openSession(db: Db, locationId: bigint, opts: { lock?: boolean } = {}) {
  const q = db
    .select(sessionColumns)
    .from(cashSessions)
    .where(and(eq(cashSessions.locationId, locationId), isNull(cashSessions.closedAt)));
  const [row] = opts.lock ? await q.for("update") : await q;
  return row;
}

export async function requireOpenSession(db: Db, locationId: bigint, message = "Abre la caja primero"): Promise<{ id: bigint }> {
  const session = await openSession(db, locationId, { lock: true });
  if (!session) throw new CashError(message);
  return session;
}

function assertWholePesos(amount: Money, what: string) {
  if (amount.minor < 0n) throw new CashError(`${what} no puede ser negativo`);
  if (amount.minor % 100n !== 0n) throw new CashError(`${what} debe ir en pesos enteros`);
  if (amount.minor > 10n ** 13n) throw new CashError(`${what} es demasiado grande`);
}

const cleanNote = (note: string | undefined) => {
  const clean = note?.trim() || null;
  if (clean && clean.length > 300) throw new CashError("La nota es muy larga");
  return clean;
};

// ─── Abrir y cerrar ──────────────────────────────────────────────────────────

export interface OpenedSession {
  sessionId: bigint;
  expected: bigint;
  difference: bigint;
  created: boolean;
}

export async function openCashSession(
  db: Db,
  input: { locationId: bigint; counted: Money; note?: string; idempotencyKey: string; actor: ActorRef; now?: Date },
): Promise<OpenedSession> {
  assertWholePesos(input.counted, "El efectivo contado");
  const note = cleanNote(input.note);
  const hash = requestHash({ kind: "cash_open", locationId: input.locationId, counted: input.counted.minor, note, by: input.actor.userId });
  return serializable(db, async (tx) => {
    const [existing] = await tx
      .select({ id: cashSessions.id, hash: cashSessions.openRequestHash, expected: cashSessions.openingExpected, counted: cashSessions.openingCounted })
      .from(cashSessions)
      .where(and(eq(cashSessions.locationId, input.locationId), eq(cashSessions.openIdempotencyKey, input.idempotencyKey)));
    if (existing) {
      assertSameRequest({ requestHash: existing.hash }, hash);
      return { sessionId: existing.id, expected: existing.expected, difference: existing.counted - existing.expected, created: false };
    }
    if (await openSession(tx, input.locationId, { lock: true })) throw new CashError("La caja ya está abierta");
    // Un turno no se abre en un día cerrado, haya o no diferencia (L1): todo lo que entre a la caja
    // durante el turno se registraría en ese día.
    const day = await requireOpenDay(tx, input.locationId, input.now ?? new Date(), (m) => new CashError(m));
    const expected = await ledgerCash(tx, input.locationId);
    const adjustment = cashAdjustmentEntry({ expected: money(expected), counted: input.counted }, note ?? undefined, {
      businessDate: day,
      memo: "Apertura de caja",
      idempotencyKey: `cash-open:${input.idempotencyKey}`,
    });
    let openingEntryId: bigint | null = null;
    if (adjustment) {
      openingEntryId = (await postEntry(tx, { locationId: input.locationId, createdBy: input.actor.userId, entry: adjustment })).entryId;
    }
    const [row] = await tx
      .insert(cashSessions)
      .values({
        locationId: input.locationId,
        openedBy: input.actor.userId,
        openingCounted: input.counted.minor,
        openingExpected: expected,
        openingNote: note,
        openingEntryId,
        openIdempotencyKey: input.idempotencyKey,
        openRequestHash: hash,
      })
      .returning({ id: cashSessions.id });
    return { sessionId: row!.id, expected, difference: input.counted.minor - expected, created: true };
  });
}

export interface ClosedSession {
  sessionId: bigint;
  expected: bigint;
  counted: bigint;
  difference: bigint;
  /** La diferencia superó el umbral de la sede: el dueño debe revisar este cierre (lo marca la base). */
  needsReview: boolean;
  created: boolean;
}

export async function closeCashSession(
  db: Db,
  input: { locationId: bigint; counted: Money; note?: string; idempotencyKey: string; actor: ActorRef; now?: Date },
): Promise<ClosedSession> {
  assertWholePesos(input.counted, "El efectivo contado");
  const note = cleanNote(input.note);
  const hash = requestHash({ kind: "cash_close", locationId: input.locationId, counted: input.counted.minor, note, by: input.actor.userId });
  return serializable(db, async (tx) => {
    const [existing] = await tx
      .select({
        id: cashSessions.id,
        hash: cashSessions.closeRequestHash,
        expected: cashSessions.expectedCash,
        counted: cashSessions.closingCounted,
        difference: cashSessions.difference,
        needsReview: cashSessions.needsReview,
      })
      .from(cashSessions)
      .where(and(eq(cashSessions.locationId, input.locationId), eq(cashSessions.closeIdempotencyKey, input.idempotencyKey)));
    if (existing) {
      assertSameRequest({ requestHash: existing.hash }, hash);
      return {
        sessionId: existing.id,
        expected: existing.expected!,
        counted: existing.counted!,
        difference: existing.difference!,
        needsReview: existing.needsReview,
        created: false,
      };
    }
    const session = await requireOpenSession(tx, input.locationId, "La caja no está abierta");
    const now = input.now ?? new Date();
    // Con la caja bloqueada, ningún cobro ni gasto en efectivo se cruza: el esperado es exacto.
    const expected = await ledgerCash(tx, input.locationId);
    const adjustment = cashAdjustmentEntry({ expected: money(expected), counted: input.counted }, note ?? undefined, {
      businessDate: "0000-00-00",
      memo: "Cierre de caja",
      idempotencyKey: `cash-close:${input.idempotencyKey}`,
    });
    let closingEntryId: bigint | null = null;
    if (adjustment) {
      const day = await requireOpenDay(tx, input.locationId, now, (m) => new CashError(m));
      closingEntryId = (await postEntry(tx, { locationId: input.locationId, createdBy: input.actor.userId, entry: { ...adjustment, businessDate: day } }))
        .entryId;
    }
    const difference = input.counted.minor - expected;
    // La hora del cierre y la marca de revisión (|diferencia| > umbral de la sede) las pone la base
    // (trigger de 0011): la app no puede fingir ni una ni otra.
    const [closed] = await tx
      .update(cashSessions)
      .set({
        closedBy: input.actor.userId,
        closedAt: sql`now()`,
        closingCounted: input.counted.minor,
        expectedCash: expected,
        difference,
        note,
        closingEntryId,
        closeIdempotencyKey: input.idempotencyKey,
        closeRequestHash: hash,
      })
      .where(and(eq(cashSessions.id, session.id), isNull(cashSessions.closedAt)))
      .returning({ needsReview: cashSessions.needsReview });
    return { sessionId: session.id, expected, counted: input.counted.minor, difference, needsReview: closed?.needsReview ?? false, created: true };
  });
}

/**
 * El dueño da por revisado un turno marcado (diferencia de apertura o de cierre mayor que el
 * umbral). Solo cerrado y una sola vez: esa revisión cubre la apertura y el cierre. La hora la pone
 * la base y el trigger de 0011 no deja cambiar nada más del turno.
 */
export async function markSessionReviewed(db: Db, input: { locationId: bigint; sessionId: bigint; actor: ActorRef }): Promise<void> {
  await serializable(db, async (tx) => {
    const [row] = await tx
      .select({
        needsReview: cashSessions.needsReview,
        openingNeedsReview: cashSessions.openingNeedsReview,
        reviewedAt: cashSessions.reviewedAt,
        closedAt: cashSessions.closedAt,
      })
      .from(cashSessions)
      .where(and(eq(cashSessions.locationId, input.locationId), eq(cashSessions.id, input.sessionId)))
      .for("update");
    if (!row) throw new CashError("El turno no existe");
    if (!row.needsReview && !row.openingNeedsReview) throw new CashError("Ese cierre no está marcado para revisión");
    if (!row.closedAt) throw new CashError("Ese turno sigue abierto: se revisa después de cerrarlo");
    if (row.reviewedAt) throw new CashError("Ese cierre ya se revisó");
    await tx
      .update(cashSessions)
      .set({ reviewedBy: input.actor.userId })
      .where(and(eq(cashSessions.locationId, input.locationId), eq(cashSessions.id, input.sessionId)));
  });
}

/**
 * Turnos marcados para revisión (apertura o cierre) que el dueño aún no revisa, los más recientes
 * primero. Incluye el turno abierto si su apertura ya quedó marcada (se revisa al cerrarlo).
 */
export async function sessionsNeedingReview(db: Db, locationId: bigint) {
  return db
    .select({
      id: cashSessions.id,
      openedAt: cashSessions.openedAt,
      openingCounted: cashSessions.openingCounted,
      openingExpected: cashSessions.openingExpected,
      openingNote: cashSessions.openingNote,
      openingNeedsReview: cashSessions.openingNeedsReview,
      needsReview: cashSessions.needsReview,
      closedAt: cashSessions.closedAt,
      // Nombre en la sede (staff_members), no el de la cuenta.
      closedBy: staffMembers.displayName,
      expected: cashSessions.expectedCash,
      counted: cashSessions.closingCounted,
      difference: cashSessions.difference,
      note: cashSessions.note,
    })
    .from(cashSessions)
    .leftJoin(staffMembers, and(eq(staffMembers.locationId, cashSessions.locationId), eq(staffMembers.userId, cashSessions.closedBy)))
    .where(
      and(
        eq(cashSessions.locationId, locationId),
        or(eq(cashSessions.needsReview, true), eq(cashSessions.openingNeedsReview, true)),
        isNull(cashSessions.reviewedAt),
      ),
    )
    .orderBy(desc(cashSessions.id))
    .limit(20);
}

// ─── Movimientos que nacen en la caja: propinas y consignaciones ─────────────

async function movementReplay(tx: Db, locationId: bigint, key: string, hash: string): Promise<bigint | undefined> {
  const [existing] = await tx
    .select({ id: cashMovements.id, hash: cashMovements.requestHash })
    .from(cashMovements)
    .where(and(eq(cashMovements.locationId, locationId), eq(cashMovements.idempotencyKey, key)));
  if (!existing) return undefined;
  assertSameRequest({ requestHash: existing.hash }, hash);
  return existing.id;
}

/**
 * Propinas por pagar a cada persona: lo causado en ventas pagadas menos lo pagado en efectivo, en
 * UNA expresión SQL (L7): una sola lectura, sin sumar en el cliente.
 */
export async function tipsOwed(db: Db, locationId: bigint): Promise<{ staffId: bigint; name: string; owed: bigint }[]> {
  const owed = sql`(
    coalesce((select sum(t.payable) from sale_tips t
                join sales s on s.location_id = t.location_id and s.id = t.sale_id
               where t.location_id = ${staffMembers.locationId} and t.staff_id = ${staffMembers.id} and s.status = 'paid'), 0)
    - coalesce((select sum(l.debit) from cash_movements m
                  join journal_lines l on l.location_id = m.location_id and l.entry_id = m.journal_entry_id
                  join accounts a on a.location_id = l.location_id and a.id = l.account_id
                 where m.location_id = ${staffMembers.locationId} and m.staff_id = ${staffMembers.id}
                   and m.kind = 'tip_payout' and a.code = ${ACCOUNTS.tipsPayable.code}), 0))`;
  return db
    .select({
      staffId: staffMembers.id,
      name: staffMembers.displayName,
      owed: sql`${owed}::text`.mapWith((v: string) => BigInt(v)),
    })
    .from(staffMembers)
    .where(and(eq(staffMembers.locationId, locationId), sql`${owed} <> 0`))
    .orderBy(asc(staffMembers.displayName), asc(staffMembers.id));
}

export async function payTips(
  db: Db,
  input: { locationId: bigint; staffId: bigint; amount: Money; idempotencyKey: string; actor: ActorRef; now?: Date },
): Promise<{ movementId: bigint; created: boolean }> {
  assertWholePesos(input.amount, "El pago de propinas");
  const hash = requestHash({ kind: "tip_payout", locationId: input.locationId, staffId: input.staffId, amount: input.amount.minor, by: input.actor.userId });
  return serializable(db, async (tx) => {
    const replay = await movementReplay(tx, input.locationId, input.idempotencyKey, hash);
    if (replay !== undefined) return { movementId: replay, created: false };
    const session = await requireOpenSession(tx, input.locationId, "Abre la caja para pagar propinas en efectivo");
    const day = await requireOpenDay(tx, input.locationId, input.now ?? new Date(), (m) => new CashError(m));
    const [person] = await tx
      .select({ name: staffMembers.displayName })
      .from(staffMembers)
      .where(and(eq(staffMembers.locationId, input.locationId), eq(staffMembers.id, input.staffId)));
    if (!person) throw new CashError("Esa persona no existe en la sede");
    const owed = (await tipsOwed(tx, input.locationId)).find((t) => t.staffId === input.staffId)?.owed ?? 0n;
    if (input.amount.minor > owed) throw new CashError(`El pago supera las propinas que se le deben a ${person.name} (${format(money(owed))})`);
    if (input.amount.minor > (await ledgerCash(tx, input.locationId))) throw cashShortError(input.actor);
    const description = `Propinas a ${person.name}`;
    const entry = tipPayoutEntry(input.amount, { businessDate: day, memo: description, idempotencyKey: `tips:${input.idempotencyKey}` });
    const posted = await postEntry(tx, { locationId: input.locationId, createdBy: input.actor.userId, entry });
    const [row] = await tx
      .insert(cashMovements)
      .values({
        locationId: input.locationId,
        cashSessionId: session.id,
        kind: "tip_payout",
        journalEntryId: posted.entryId,
        staffId: input.staffId,
        description,
        createdBy: input.actor.userId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      })
      .returning({ id: cashMovements.id });
    return { movementId: row!.id, created: true };
  });
}

export async function cashDeposit(
  db: Db,
  input: { locationId: bigint; amount: Money; idempotencyKey: string; actor: ActorRef; now?: Date },
): Promise<{ movementId: bigint; created: boolean }> {
  assertWholePesos(input.amount, "La consignación");
  const hash = requestHash({ kind: "cash_deposit", locationId: input.locationId, amount: input.amount.minor, by: input.actor.userId });
  return serializable(db, async (tx) => {
    const replay = await movementReplay(tx, input.locationId, input.idempotencyKey, hash);
    if (replay !== undefined) return { movementId: replay, created: false };
    const session = await requireOpenSession(tx, input.locationId, "Abre la caja para consignar");
    const day = await requireOpenDay(tx, input.locationId, input.now ?? new Date(), (m) => new CashError(m));
    if (input.amount.minor > (await ledgerCash(tx, input.locationId))) throw cashShortError(input.actor);
    const description = "Consignación al banco";
    const entry = cashDepositEntry(input.amount, { businessDate: day, memo: description, idempotencyKey: `deposit:${input.idempotencyKey}` });
    const posted = await postEntry(tx, { locationId: input.locationId, createdBy: input.actor.userId, entry });
    const [row] = await tx
      .insert(cashMovements)
      .values({
        locationId: input.locationId,
        cashSessionId: session.id,
        kind: "cash_deposit",
        journalEntryId: posted.entryId,
        description,
        createdBy: input.actor.userId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      })
      .returning({ id: cashMovements.id });
    return { movementId: row!.id, created: true };
  });
}

// ─── Día contable ────────────────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Lee lo que escriben quienes registran en el día (M1). Cada asiento lee day_close_events (¿está
 * cerrado el día?) y quien cierra o reabre escribe ahí; si quien cierra no lee también los asientos
 * de ese día, SSI solo ve una dependencia en un sentido y deja pasar las dos transacciones: un
 * asiento con una foto vieja (tomada antes del cierre) entra a un día ya cerrado. Con esta lectura
 * hay un ciclo lectura-escritura en los dos sentidos y Postgres aborta a una (40001), que se repite
 * con datos frescos (serializable()).
 */
async function readDayEntries(tx: Db, locationId: bigint, day: string): Promise<bigint> {
  const [row] = await tx
    .select({ n: sql<string>`count(*)::text` })
    .from(journalEntries)
    .where(and(eq(journalEntries.locationId, locationId), eq(journalEntries.businessDate, day)));
  return BigInt(row?.n ?? "0");
}

/** Cierra el día: solo sin caja abierta (también lo exige la base) y nunca un día que no ha llegado. */
export async function closeBusinessDay(db: Db, input: { locationId: bigint; businessDate: string; actor: ActorRef; now?: Date }): Promise<void> {
  if (!DATE.test(input.businessDate)) throw new CashError("Fecha inválida");
  await serializable(db, async (tx) => {
    const day = await today(tx, input.locationId, input.now ?? new Date());
    if (input.businessDate > day.businessDate) throw new CashError("No se puede cerrar un día que no ha llegado");
    if (await openSession(tx, input.locationId)) throw new CashError("Cierra la caja antes de cerrar el día");
    if (await isDayClosed(tx, input.locationId, input.businessDate)) throw new CashError("El día ya está cerrado");
    await readDayEntries(tx, input.locationId, input.businessDate);
    await closeDay(tx, { locationId: input.locationId, businessDate: input.businessDate, createdBy: input.actor.userId });
  });
}

export async function reopenBusinessDay(
  db: Db,
  input: { locationId: bigint; businessDate: string; reason: string; actor: ActorRef },
): Promise<void> {
  if (!DATE.test(input.businessDate)) throw new CashError("Fecha inválida");
  const reason = input.reason.trim();
  if (!reason) throw new CashError("Escribe el motivo para reabrir el día");
  if (reason.length > 300) throw new CashError("El motivo es muy largo");
  await serializable(db, async (tx) => {
    if (!(await isDayClosed(tx, input.locationId, input.businessDate))) throw new CashError("El día no está cerrado");
    await readDayEntries(tx, input.locationId, input.businessDate);
    await reopenDay(tx, { locationId: input.locationId, businessDate: input.businessDate, reason, createdBy: input.actor.userId });
  });
}

// ─── Lecturas para la pantalla de caja ───────────────────────────────────────

export type MovementKind = "sale" | "expense" | "tip_payout" | "cash_deposit" | "reversal";

export interface SessionSummary {
  id: bigint;
  openedAt: Date;
  openedBy: string;
  openingCounted: bigint;
  /** Saldo de 1105 en el libro: el esperado. */
  expected: bigint;
  /** Efecto neto en 1105 de los movimientos del turno, por tipo. */
  byKind: Map<MovementKind, bigint>;
  /** expected − (base + movimientos): siempre 0 salvo que algo tocara 1105 fuera de la caja. */
  unexplained: bigint;
  movements: { at: Date; kind: MovementKind; description: string; net: bigint }[];
  /** Total cobrado en el turno por cada medio que no es efectivo (para cuadrar con datáfono y extractos). */
  byMethod: { label: string; total: bigint }[];
}

/** Efecto en 1105 (débitos − créditos) de cada movimiento del turno, sumado en SQL. */
async function sessionMovements(db: Db, locationId: bigint, sessionId: bigint) {
  return db
    .select({
      id: cashMovements.id,
      at: cashMovements.createdAt,
      kind: cashMovements.kind,
      description: cashMovements.description,
      debits: sumAsBigint(journalLines.debit),
      credits: sumAsBigint(journalLines.credit),
    })
    .from(cashMovements)
    .innerJoin(journalLines, and(eq(journalLines.locationId, cashMovements.locationId), eq(journalLines.entryId, cashMovements.journalEntryId)))
    .innerJoin(accounts, and(eq(accounts.locationId, journalLines.locationId), eq(accounts.id, journalLines.accountId)))
    .where(and(eq(cashMovements.locationId, locationId), eq(cashMovements.cashSessionId, sessionId), eq(accounts.code, ACCOUNTS.cash.code)))
    .groupBy(cashMovements.id, cashMovements.createdAt, cashMovements.kind, cashMovements.description)
    .orderBy(asc(cashMovements.id));
}

/** Suma por tipo de los movimientos del turno (SQL). */
async function sessionTotalsByKind(db: Db, locationId: bigint, sessionId: bigint) {
  return db
    .select({ kind: cashMovements.kind, debits: sumAsBigint(journalLines.debit), credits: sumAsBigint(journalLines.credit) })
    .from(cashMovements)
    .innerJoin(journalLines, and(eq(journalLines.locationId, cashMovements.locationId), eq(journalLines.entryId, cashMovements.journalEntryId)))
    .innerJoin(accounts, and(eq(accounts.locationId, journalLines.locationId), eq(accounts.id, journalLines.accountId)))
    .where(and(eq(cashMovements.locationId, locationId), eq(cashMovements.cashSessionId, sessionId), eq(accounts.code, ACCOUNTS.cash.code)))
    .groupBy(cashMovements.kind);
}

export async function sessionSummary(db: Db, locationId: bigint): Promise<SessionSummary | null> {
  const [session] = await db
    // Nombre en la sede (staff_members), no el de la cuenta: ese lo controla cada quien.
    .select({ ...sessionColumns, openedByName: staffMembers.displayName })
    .from(cashSessions)
    .leftJoin(staffMembers, and(eq(staffMembers.locationId, cashSessions.locationId), eq(staffMembers.userId, cashSessions.openedBy)))
    .where(and(eq(cashSessions.locationId, locationId), isNull(cashSessions.closedAt)));
  if (!session) return null;
  const [totals, rows, expected, methods] = await Promise.all([
    sessionTotalsByKind(db, locationId, session.id),
    sessionMovements(db, locationId, session.id),
    ledgerCash(db, locationId),
    db
      .select({ label: salePayments.label, total: sumAsBigint(salePayments.amount) })
      .from(salePayments)
      .innerJoin(sales, and(eq(sales.locationId, salePayments.locationId), eq(sales.id, salePayments.saleId)))
      .where(
        and(
          eq(salePayments.locationId, locationId),
          ne(salePayments.kind, "cash"),
          eq(sales.status, "paid"),
          gte(sales.createdAt, session.openedAt),
          // El día contable de la apertura acota las ventas por el índice (location_id, business_date) (L6).
          sql`${sales.businessDate} >= (select (cs.opened_at at time zone l.timezone)::date
                                          from cash_sessions cs join locations l on l.id = cs.location_id
                                         where cs.id = ${session.id})`,
        ),
      )
      .groupBy(salePayments.label)
      .orderBy(asc(salePayments.label)),
  ]);
  const byKind = new Map<MovementKind, bigint>(totals.map((t) => [t.kind, t.debits - t.credits]));
  let accounted = session.openingCounted;
  for (const v of byKind.values()) accounted += v;
  return {
    id: session.id,
    openedAt: session.openedAt,
    openedBy: session.openedByName ?? "Personal",
    openingCounted: session.openingCounted,
    expected,
    byKind,
    unexplained: expected - accounted,
    movements: rows.map((r) => ({ at: r.at, kind: r.kind, description: r.description, net: r.debits - r.credits })),
    byMethod: methods,
  };
}

/** Esperado del turno abierto calculado SOLO con sus movimientos: base + Σ movimientos (SQL). */
export async function sessionExpectedFromMovements(db: Db, locationId: bigint, sessionId: bigint): Promise<bigint> {
  const [session] = await db
    .select({ base: cashSessions.openingCounted })
    .from(cashSessions)
    .where(and(eq(cashSessions.locationId, locationId), eq(cashSessions.id, sessionId)));
  if (!session) throw new CashError("El turno no existe en esta sede");
  const totals = await sessionTotalsByKind(db, locationId, sessionId);
  return totals.reduce((acc, t) => acc + t.debits - t.credits, session.base);
}

export async function lastClosedSession(db: Db, locationId: bigint) {
  const [row] = await db
    .select({
      closedAt: cashSessions.closedAt,
      counted: cashSessions.closingCounted,
      expected: cashSessions.expectedCash,
      difference: cashSessions.difference,
      note: cashSessions.note,
    })
    .from(cashSessions)
    .where(and(eq(cashSessions.locationId, locationId), isNotNull(cashSessions.closedAt)))
    .orderBy(desc(cashSessions.closedAt), desc(cashSessions.id))
    .limit(1);
  return row ? { closedAt: row.closedAt!, counted: row.counted!, expected: row.expected!, difference: row.difference!, note: row.note } : null;
}

/** Ventas del día contable con quién cobró y si tienen una anulación pendiente. */
export async function daySales(db: Db, locationId: bigint, day: string) {
  return db
    .select({
      saleId: sales.id,
      at: sales.createdAt,
      clientName: clients.name,
      total: sales.totalPaid,
      status: sales.status,
      chargedBy: staffMembers.displayName,
      voidRequested: sql<boolean>`exists (select 1 from ${voidRequests} vr where vr.sale_id = ${sales.id} and vr.status = 'pending')`,
    })
    .from(sales)
    .leftJoin(clients, and(eq(clients.locationId, sales.locationId), eq(clients.id, sales.clientId)))
    .leftJoin(staffMembers, and(eq(staffMembers.locationId, sales.locationId), eq(staffMembers.userId, sales.createdBy)))
    .where(and(eq(sales.locationId, locationId), eq(sales.businessDate, day)))
    .orderBy(desc(sales.id));
}

/**
 * Todo lo que muestra la pantalla de caja, leído en UNA transacción REPEATABLE READ de solo
 * lectura (L3): el esperado, el desglose, las propinas y las ventas salen de la misma foto del libro,
 * así que un cobro que entra a mitad de la lectura no deja la pantalla descuadrada.
 */
export async function cashViewData(db: Db, locationId: bigint, now: Date = new Date()) {
  return db.transaction(
    async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const day = await today(tx, locationId, now);
      const summary = await sessionSummary(tx, locationId);
      const closed = await lastClosedSession(tx, locationId);
      const owed = await tipsOwed(tx, locationId);
      const categories = await listExpenseCategories(tx, { locationId, activeOnly: true });
      const salesOfDay = await daySales(tx, locationId, day.businessDate);
      const ledger = await ledgerCash(tx, locationId);
      const flagged = await sessionsNeedingReview(tx, locationId);
      return { day, summary, closed, owed, categories, sales: salesOfDay, ledger, flagged };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
