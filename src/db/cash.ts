import { and, asc, desc, eq, gte, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { cashAdjustmentEntry, cashDepositEntry, CashError, sessionIsFromEarlierDay, staleSessionMessage, tipPayoutEntry } from "@/domain/sales/cash";
import { format, type Money, money } from "@/domain/money";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import { can, type Role } from "@/domain/staff/roles";
import { recordAudit } from "./audit";
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
import { rowsOf, sumAsBigint } from "./sql";
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
  /** Día contable del turno: la fecha local de la sede al abrirlo. */
  businessDate: sql<string>`(("cash_sessions"."opened_at" at time zone (select l.timezone from locations l where l.id = "cash_sessions"."location_id"))::date)::text`,
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

/** ¿Hay caja abierta de ese día? Una que quedó abierta de un día anterior no cuenta: no recibe efectivo. */
export async function sessionOpenOn(db: Db, locationId: bigint, day: string): Promise<boolean> {
  const session = await openSession(db, locationId);
  return Boolean(session) && !sessionIsFromEarlierDay(session!.businessDate, day);
}

/**
 * La caja abierta HOY, bloqueada. Un turno que quedó abierto de un día anterior no recibe efectivo
 * de hoy (sus ventas se mezclarían): primero se cierra con conteo (closeCashSession lo permite).
 */
export async function requireOpenSession(
  db: Db,
  locationId: bigint,
  message = "Abre la caja primero",
  now: Date = new Date(),
): Promise<{ id: bigint }> {
  const session = await openSession(db, locationId, { lock: true });
  if (!session) throw new CashError(message);
  const day = await today(db, locationId, now);
  if (sessionIsFromEarlierDay(session.businessDate, day.businessDate)) throw new CashError(staleSessionMessage(session.businessDate));
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

/** La hora de la base (inicio de la transacción), la misma que usan los triggers. */
export async function databaseNow(db: Db): Promise<Date> {
  const [row] = rowsOf<{ now: Date | string }>(await db.execute(sql`select now() as now`));
  return new Date(row!.now);
}

/** Motivo con el que queda la reapertura automática de hoy al abrir la caja. */
export const REOPEN_ON_CASH_OPEN_REASON = "Se abrió la caja con el día de hoy cerrado";

export async function openCashSession(
  db: Db,
  input: {
    locationId: bigint;
    counted: Money;
    note?: string;
    idempotencyKey: string;
    actor: ActorRef;
    now?: Date;
    /**
     * Si hoy está cerrado, lo reabre en la misma transacción en vez de rechazar la apertura
     * (recepción y dueño: la operación no se para porque el día se cerró antes de tiempo). Solo
     * toca HOY; un día anterior cerrado sigue cerrado. Queda en la bitácora con quien abrió.
     */
    reopenClosedToday?: boolean;
  },
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
    // El día de la apertura sale del reloj de la BASE, el mismo con que la base pone opened_at: con
    // relojes desfasados cerca de medianoche, el asiento y el turno no quedan en días distintos.
    const now = input.now ?? (await databaseNow(tx));
    const current = await today(tx, input.locationId, now);
    if (current.closed && input.reopenClosedToday) {
      const [prior] = rowsOf<{ n: string }>(
        await tx.execute(sql`
          select count(*)::text as n from day_close_events
           where location_id = ${input.locationId}::bigint and business_date = ${current.businessDate}::date and action = 'reopen'
        `),
      );
      const times = Number(prior?.n ?? "0") + 1;
      await reopenDay(tx, { locationId: input.locationId, businessDate: current.businessDate, reason: REOPEN_ON_CASH_OPEN_REASON, createdBy: input.actor.userId });
      await recordAudit(tx, {
        locationId: input.locationId,
        actorUserId: input.actor.userId,
        action: "day.reopen",
        targetKind: "business_day",
        targetRef: current.businessDate,
        summary: `Reabrió el día ${current.businessDate} al abrir la caja (reapertura automática; ${times === 1 ? "primera vez" : `${times} veces`} ese día)`,
      });
    }
    const day = await requireOpenDay(tx, input.locationId, now, (m) => new CashError(m));
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
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "cash.open",
      targetKind: "cash_session",
      targetRef: row!.id.toString(),
      summary: `Abrió la caja con ${format(input.counted)} contados (diferencia ${format(money(input.counted.minor - expected))})`,
    });
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
    // Aquí sí vale un turno de un día anterior: cerrarlo tarde es justo lo que hay que hacer.
    const session = await openSession(tx, input.locationId, { lock: true });
    if (!session) throw new CashError("La caja no está abierta");
    const now = input.now ?? new Date();
    const late = sessionIsFromEarlierDay(session.businessDate, (await today(tx, input.locationId, now)).businessDate);
    // Con la caja bloqueada, ningún cobro ni gasto en efectivo se cruza: el esperado es exacto. En un
    // cierre tardío tampoco entró efectivo hoy (requireOpenSession lo impide): es el saldo del día del turno.
    const expected = await ledgerCash(tx, input.locationId);
    // El ajuste del cierre va al día del turno: un faltante de ayer es de ayer. Ese día sigue abierto
    // (la base no deja cerrarlo con caja abierta), pero se comprueba igual.
    const adjustment = cashAdjustmentEntry({ expected: money(expected), counted: input.counted }, note ?? undefined, {
      businessDate: session.businessDate,
      memo: late ? `Cierre de caja del ${session.businessDate} (tardío)` : "Cierre de caja",
      idempotencyKey: `cash-close:${input.idempotencyKey}`,
    });
    let closingEntryId: bigint | null = null;
    if (adjustment) {
      if (await isDayClosed(tx, input.locationId, session.businessDate)) {
        throw new CashError(`El día ${session.businessDate} ya está cerrado. El dueño debe reabrirlo para registrar el cierre de caja.`);
      }
      closingEntryId = (await postEntry(tx, { locationId: input.locationId, createdBy: input.actor.userId, entry: adjustment })).entryId;
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
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "cash.close",
      targetKind: "cash_session",
      targetRef: session.id.toString(),
      summary: `${late ? `Cerró tarde la caja del ${session.businessDate}` : "Cerró la caja"} con ${format(input.counted)} contados (diferencia ${format(money(difference))})`,
    });
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
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "cash.review",
      targetKind: "cash_session",
      targetRef: input.sessionId.toString(),
      summary: "Dio por revisado un turno de caja marcado",
    });
  });
}

/**
 * Turnos marcados para revisión (apertura o cierre) que el dueño aún no revisa, los más recientes
 * primero. Incluye el turno abierto si su apertura ya quedó marcada (se revisa al cerrarlo).
 */
export async function sessionsNeedingReview(db: Db, locationId: bigint) {
  const opener = alias(staffMembers, "opener");
  return db
    .select({
      id: cashSessions.id,
      openedAt: cashSessions.openedAt,
      // Quien abre responde por la diferencia de apertura; quien cierra, por la del cierre.
      openedBy: opener.displayName,
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
    .leftJoin(opener, and(eq(opener.locationId, cashSessions.locationId), eq(opener.userId, cashSessions.openedBy)))
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
 * Toma la fila de la persona FOR UPDATE: todo lo que mueve sus saldos (liquidar, revertir, anticipos,
 * pagar propinas) se hace en fila (docs/sprint-5-comisiones-informes.md §5).
 */
export async function lockStaff(tx: Db, locationId: bigint, staffId: bigint): Promise<{ name: string; active: boolean }> {
  const [person] = await tx
    .select({ name: staffMembers.displayName, active: staffMembers.active })
    .from(staffMembers)
    .where(and(eq(staffMembers.locationId, locationId), eq(staffMembers.id, staffId)))
    .for("update");
  if (!person) throw new CashError("Esa persona no existe en la sede");
  return person;
}

/**
 * Propinas por pagar a cada persona: la definición es staff_tips_owed (0013), así que Caja ve también
 * lo pagado en liquidaciones. UNA expresión SQL (L7): una sola lectura, sin sumar en el cliente.
 */
export async function tipsOwed(db: Db, locationId: bigint): Promise<{ staffId: bigint; name: string; owed: bigint }[]> {
  const owed = sql`staff_tips_owed(${staffMembers.locationId}, ${staffMembers.id})`;
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
    // Primero la persona (mismo orden que liquidar): un pago de propinas y una liquidación van en fila.
    const person = await lockStaff(tx, input.locationId, input.staffId);
    const session = await requireOpenSession(tx, input.locationId, "Abre la caja para pagar propinas en efectivo", input.now);
    const day = await requireOpenDay(tx, input.locationId, input.now ?? new Date(), (m) => new CashError(m));
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
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "tips.pay",
      targetKind: "cash_movement",
      targetRef: row!.id.toString(),
      summary: `Pagó ${format(input.amount)} de propinas a ${person.name}`,
    });
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
    const session = await requireOpenSession(tx, input.locationId, "Abre la caja para consignar", input.now);
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
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "cash.deposit",
      targetKind: "cash_movement",
      targetRef: row!.id.toString(),
      summary: `Consignó ${format(input.amount)} al banco`,
    });
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

/** Cierra el día: sin caja abierta de ese día o antes (también lo exige la base, 0020) y nunca un día que no ha llegado. */
export async function closeBusinessDay(db: Db, input: { locationId: bigint; businessDate: string; actor: ActorRef; now?: Date }): Promise<void> {
  if (!DATE.test(input.businessDate)) throw new CashError("Fecha inválida");
  await serializable(db, async (tx) => {
    const day = await today(tx, input.locationId, input.now ?? new Date());
    if (input.businessDate > day.businessDate) throw new CashError("No se puede cerrar un día que no ha llegado");
    // La caja abierta de un día POSTERIOR no impide cerrar este (cierre tardío); la de este día o antes, sí.
    const session = await openSession(tx, input.locationId);
    if (session && session.businessDate <= input.businessDate) throw new CashError("Cierra la caja antes de cerrar el día");
    if (await isDayClosed(tx, input.locationId, input.businessDate)) throw new CashError("El día ya está cerrado");
    await readDayEntries(tx, input.locationId, input.businessDate);
    await closeDay(tx, { locationId: input.locationId, businessDate: input.businessDate, createdBy: input.actor.userId });
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "day.close",
      targetKind: "business_day",
      targetRef: input.businessDate,
      summary: `Cerró el día ${input.businessDate}`,
    });
  });
}

/** La última reapertura de ese día (quién, cuándo y por qué), para que se vea en Caja. */
export async function lastReopenOf(db: Db, locationId: bigint, day: string): Promise<{ by: string; at: Date; reason: string } | null> {
  const [row] = rowsOf<{ by: string | null; at: Date | string; reason: string }>(
    await db.execute(sql`
      select m.display_name as by, e.created_at as at, e.reason
        from day_close_events e
        left join staff_members m on m.location_id = e.location_id and m.user_id = e.created_by
       where e.location_id = ${locationId}::bigint and e.business_date = ${day}::date and e.action = 'reopen'
       order by e.id desc
       limit 1
    `),
  );
  return row ? { by: row.by ?? "Personal", at: new Date(row.at), reason: row.reason } : null;
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
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "day.reopen",
      targetKind: "business_day",
      targetRef: input.businessDate,
      summary: `Reabrió el día ${input.businessDate}: ${reason}`,
    });
  });
}

// ─── Lecturas para la pantalla de caja ───────────────────────────────────────

export type MovementKind = "sale" | "expense" | "tip_payout" | "cash_deposit" | "reversal" | "commission_payout" | "staff_advance" | "inventory_purchase" | "supplier_payment";

export interface SessionSummary {
  id: bigint;
  /** Día contable del turno (fecha local de la apertura). */
  businessDate: string;
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
          // Vigentes ese día: una venta anulada DESPUÉS (la reversa va el día de la anulación) sigue
          // contando en su día, como en el libro; la anulada ese mismo día no.
          sql`not exists (select 1 from journal_entries e
                           where e.location_id = ${sales.locationId} and e.id = ${sales.voidEntryId} and e.business_date = ${sales.businessDate})`,
          // Las ventas del DÍA del turno (por el índice location_id, business_date; L6): no se cuentan
          // y sirven para cuadrar con el datáfono. Sin cota por la hora de apertura: una venta con
          // tarjeta antes de abrir la caja también es del día. Lo de hoy no se suma a una caja de ayer.
          eq(sales.businessDate, session.businessDate),
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
    businessDate: session.businessDate,
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

/**
 * Citas del día contable que ya se pueden cobrar (en la silla o terminadas, como exige checkout)
 * y no tienen venta vigente ni cortesía: la lista "Por cobrar" de la caja, en orden de hora.
 */
export async function appointmentsToCharge(db: Db, locationId: bigint, day: string) {
  const rows = rowsOf<{ id: string; start: string; status: "in_chair" | "completed"; client: string | null; service: string; staff: string; price: string }>(
    await db.execute(sql`
      -- Nombre y precio congelados en la cita (lo que cobra checkout), no los del catálogo de hoy.
      select a.id::text, lower(a.during) as start, a.status, c.name as client, a.service_name as service,
             m.display_name as staff, a.price::text
        from appointments a
        join locations l on l.id = a.location_id
        join staff_members m on m.location_id = a.location_id and m.id = a.staff_id
        left join clients c on c.location_id = a.location_id and c.id = a.client_id
       where a.location_id = ${locationId}::bigint
         and a.status in ('in_chair', 'completed')
         and (lower(a.during) at time zone l.timezone)::date = ${day}::date
         and not exists (
           select 1 from sales s
            where s.location_id = a.location_id and s.appointment_id = a.id and s.status = 'paid'
         )
         -- Sprint 8: la que se dio como cortesía no se cobra.
         and not exists (
           select 1 from appointment_courtesies ac
            where ac.location_id = a.location_id and ac.appointment_id = a.id
         )
       order by lower(a.during), a.id
    `),
  );
  return rows.map((r) => ({
    appointmentId: BigInt(r.id),
    start: new Date(r.start),
    status: r.status,
    clientName: r.client,
    serviceName: r.service,
    staffName: r.staff,
    price: BigInt(r.price),
  }));
}

/** Ventas del día contable con quién cobró y si tienen una anulación pendiente. */
export async function daySales(db: Db, locationId: bigint, day: string) {
  return db
    .select({
      saleId: sales.id,
      publicId: sales.publicId,
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
/**
 * El día anterior más reciente sin cerrar: con asientos en la última semana (la caja se cerró tarde
 * o nadie cerró el día) o reabierto alguna vez y no vuelto a cerrar. Desde Caja se cierra.
 */
export async function lastUnclosedPastDay(db: Db, locationId: bigint, today: string): Promise<string | null> {
  const [row] = rowsOf<{ day: string | null }>(
    await db.execute(sql`
      select max(d.day)::text as day
        from (select distinct e.business_date as day from journal_entries e
               where e.location_id = ${locationId}::bigint
                 and e.business_date < ${today}::date and e.business_date >= ${today}::date - 7
              union
              -- Reabierto (para anular, corregir…) y nunca vuelto a cerrar: sin límite de antigüedad.
              select ev.business_date from day_close_events ev
               where ev.location_id = ${locationId}::bigint and ev.business_date < ${today}::date and ev.action = 'reopen') d
       where not ledger_day_is_closed(${locationId}::bigint, d.day)
    `),
  );
  return row?.day ?? null;
}

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
      const toCharge = await appointmentsToCharge(tx, locationId, day.businessDate);
      const pendingDay = await lastUnclosedPastDay(tx, locationId, day.businessDate);
      const reopened = await lastReopenOf(tx, locationId, day.businessDate);
      return { day, summary, closed, owed, categories, sales: salesOfDay, ledger, flagged, toCharge, pendingDay, reopened };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
