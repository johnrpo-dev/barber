import { and, asc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { BookingError, fitsSchedule, isLateCancellation, occupiedRange, overlapsBusy, planWalkIn } from "@/domain/booking/appointment";
import { availableSlots, type BusyInterval, pickStaffForAny, type Slot } from "@/domain/booking/availability";
import { addDays, isoWeekday, localMinuteOf, localMinuteToInstant, MINUTE_MS } from "@/domain/booking/clock";
import {
  ACTIVE_STATUSES,
  type AppointmentStatus,
  assertTransition,
  type CancelReason,
} from "@/domain/booking/status";
import { businessDate } from "@/domain/ledger/business-date";
import { type Money, money } from "@/domain/money";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import type { Role } from "@/domain/staff/roles";
import { formatTime, type ScheduleBlock, type Weekday } from "@/domain/staff/schedule";
import {
  appointmentEvents,
  appointments,
  clients,
  locations,
  services,
  staffMembers,
  staffSchedules,
  timeOff,
  user,
} from "./schema";
import { extendManageLink, revokeManageLinks } from "./manage-links";
import { pgError } from "./serializable";
import type { TimeRange } from "./tstzrange";
import type { Db } from "./types";
import { ulid } from "./ulid";

// Servicio de la agenda. El dominio decide qué se ofrece y quién puede hacer qué; Postgres
// garantiza que nunca haya doble reserva (EXCLUDE) y que los estados no se salten.

export class SlotTakenError extends Error {
  constructor(message = "Ese horario ya no está libre. Elige otro.") {
    super(message);
    this.name = "SlotTakenError";
  }
}

export interface StaffActor {
  userId: string;
  role: Role;
  staffId: bigint;
}

/** Quién mueve la cita: el personal, el cliente con su enlace de gestión, o el sistema (retenciones). */
export type AgendaActor = StaffActor | { kind: "client" } | { kind: "system" };

function actorFields(actor: AgendaActor): { actorKind: "staff" | "client" | "system"; actorUserId: string | null } {
  return "kind" in actor ? { actorKind: actor.kind, actorUserId: null } : { actorKind: "staff", actorUserId: actor.userId };
}

const pgCode = pgError;

const isExclusionViolation = (err: unknown) => pgCode(err).code === "23P01";

const range = (from: Date, to: Date) => sql`tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')`;

// ─── Lecturas de apoyo ───────────────────────────────────────────────────────

export interface LocationRules {
  timeZone: string;
  slotStepMin: number;
  minAdvanceMin: number;
  maxAdvanceDays: number;
  holdMin: number;
  freeCancelHours: number;
  noShowGraceMin: number;
}

export async function locationRules(db: Db, locationId: bigint): Promise<LocationRules> {
  const [row] = await db
    .select({
      timeZone: locations.timezone,
      slotStepMin: locations.slotStepMin,
      minAdvanceMin: locations.minAdvanceMin,
      maxAdvanceDays: locations.maxAdvanceDays,
      holdMin: locations.holdMin,
      freeCancelHours: locations.freeCancelHours,
      noShowGraceMin: locations.noShowGraceMin,
    })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!row) throw new Error(`La sede ${locationId} no existe`);
  return row;
}

interface StaffWithBlocks {
  staffId: bigint;
  displayName: string;
  role: string;
  blocks: ScheduleBlock[];
}

/** Personal activo con su horario semanal. `onlineOnly`: solo quienes se ofrecen en la reserva pública. */
async function activeStaff(
  db: Db,
  locationId: bigint,
  staffIds?: readonly bigint[],
  onlineOnly = false,
): Promise<StaffWithBlocks[]> {
  const rows = await db
    .select({
      staffId: staffMembers.id,
      displayName: staffMembers.displayName,
      role: staffMembers.role,
      weekday: staffSchedules.weekday,
      startMin: staffSchedules.startMin,
      endMin: staffSchedules.endMin,
    })
    .from(staffMembers)
    .leftJoin(
      staffSchedules,
      and(eq(staffSchedules.locationId, staffMembers.locationId), eq(staffSchedules.staffId, staffMembers.id)),
    )
    .where(
      and(
        eq(staffMembers.locationId, locationId),
        eq(staffMembers.active, true),
        staffIds ? inArray(staffMembers.id, [...staffIds]) : undefined,
        onlineOnly ? eq(staffMembers.bookableOnline, true) : undefined,
      ),
    )
    .orderBy(asc(staffMembers.displayName), asc(staffMembers.id), asc(staffSchedules.weekday), asc(staffSchedules.startMin));
  const byId = new Map<bigint, StaffWithBlocks>();
  for (const r of rows) {
    const s = byId.get(r.staffId) ?? { staffId: r.staffId, displayName: r.displayName, role: r.role, blocks: [] };
    if (r.weekday !== null && r.startMin !== null && r.endMin !== null) {
      s.blocks.push({ weekday: r.weekday as Weekday, startMin: r.startMin, endMin: r.endMin });
    }
    byId.set(r.staffId, s);
  }
  return [...byId.values()];
}

/** Lo que ocupa tiempo: citas activas (sin contar reservas vencidas) y ausencias vigentes. */
async function busyIntervals(
  db: Db,
  input: { locationId: bigint; from: Date; to: Date; now: Date; excludeAppointmentId?: bigint; onlyTimeOff?: boolean },
): Promise<BusyInterval[]> {
  const appts = input.onlyTimeOff
    ? []
    : await db
    .select({ staffId: appointments.staffId, during: appointments.during })
    .from(appointments)
    .where(
      and(
        eq(appointments.locationId, input.locationId),
        inArray(appointments.status, [...ACTIVE_STATUSES]),
        sql`not (${appointments.status} = 'pending' and ${appointments.expiresAt} <= ${input.now.toISOString()}::timestamptz)`,
        sql`${appointments.during} && ${range(input.from, input.to)}`,
        input.excludeAppointmentId ? ne(appointments.id, input.excludeAppointmentId) : undefined,
      ),
    );
  const off = await db
    .select({ staffId: timeOff.staffId, during: timeOff.during })
    .from(timeOff)
    .where(
      and(
        eq(timeOff.locationId, input.locationId),
        isNull(timeOff.cancelledAt),
        sql`${timeOff.during} && ${range(input.from, input.to)}`,
      ),
    );
  return [...appts, ...off].map((r) => ({ staffId: r.staffId, start: r.during.start, end: r.during.end }));
}

async function activeService(db: Db, locationId: bigint, serviceId: bigint) {
  const [svc] = await db
    .select({
      id: services.id,
      name: services.name,
      durationMin: services.durationMin,
      bufferMin: services.bufferMin,
      price: services.price,
    })
    .from(services)
    .where(and(eq(services.locationId, locationId), eq(services.id, serviceId), eq(services.active, true)));
  if (!svc) throw new BookingError("El servicio no existe o ya no se ofrece");
  return svc;
}

/**
 * Cancela las reservas en línea que no se verificaron a tiempo y libera su horario.
 * Sin sede: todas (el worker lo corre cada minuto).
 */
export async function expireHolds(db: Db, locationId: bigint | null, now: Date): Promise<number> {
  const expired = await db
    .update(appointments)
    .set({ status: "cancelled", cancelReason: "expired" })
    .where(
      and(
        locationId === null ? undefined : eq(appointments.locationId, locationId),
        eq(appointments.status, "pending"),
        lt(appointments.expiresAt, now),
      ),
    )
    .returning({ id: appointments.id, locationId: appointments.locationId });
  if (expired.length > 0) {
    await db.insert(appointmentEvents).values(
      expired.map((a) => ({
        locationId: a.locationId,
        appointmentId: a.id,
        kind: "status" as const,
        fromStatus: "pending",
        toStatus: "cancelled",
        actorKind: "system" as const,
        reason: "La reserva no se verificó a tiempo",
      })),
    );
  }
  return expired.length;
}

// ─── Disponibilidad ──────────────────────────────────────────────────────────

/** Horarios libres para un servicio. `internal` (recepción) no aplica la anticipación mínima. */
export async function availability(
  db: Db,
  input: {
    locationId: bigint;
    serviceId: bigint;
    fromDate: string;
    toDate: string;
    staffId?: bigint;
    now?: Date;
    internal: boolean;
    /** Al reprogramar, la propia cita no cuenta como ocupada. */
    excludeAppointmentId?: bigint;
    /** Ignora las citas (solo turnos y ausencias): sirve para distinguir "cerrado" de "lleno". */
    ignoreAppointments?: boolean;
  },
): Promise<Slot[]> {
  const now = input.now ?? new Date();
  const rules = await locationRules(db, input.locationId);
  const svc = await activeService(db, input.locationId, input.serviceId);
  // Lo público solo ofrece a quienes atienden en línea; recepción ve a todo el equipo.
  const staff = (await activeStaff(db, input.locationId, input.staffId ? [input.staffId] : undefined, !input.internal)).filter(
    (s) => s.blocks.length > 0,
  );
  const from = localMinuteToInstant(input.fromDate, 0, rules.timeZone);
  const to = localMinuteToInstant(addDays(input.toDate, 2), 0, rules.timeZone);
  return availableSlots({
    timeZone: rules.timeZone,
    now,
    fromDate: input.fromDate,
    toDate: input.toDate,
    durationMin: svc.durationMin,
    bufferMin: svc.bufferMin,
    stepMin: rules.slotStepMin,
    minAdvanceMin: input.internal ? 0 : rules.minAdvanceMin,
    maxAdvanceDays: input.internal ? 366 : rules.maxAdvanceDays,
    staff,
    busy: await busyIntervals(db, {
      locationId: input.locationId,
      from,
      to,
      now,
      excludeAppointmentId: input.excludeAppointmentId,
      onlyTimeOff: input.ignoreAppointments,
    }),
  });
}

// ─── Crear ───────────────────────────────────────────────────────────────────

export interface CreateAppointmentInput {
  locationId: bigint;
  serviceId: bigint;
  /** "any" = Cualquiera: el barbero libre con menos carga ese día. */
  staffId: bigint | "any";
  start: Date;
  clientId: bigint | null;
  source: "staff" | "walk_in" | "online";
  notes?: string;
  idempotencyKey: string;
  /** user.id de quien agenda; en reservas en línea, "online". */
  createdBy: string;
  /** Solo el personal, y confirmándolo: agendar fuera del turno. */
  allowOutsideHours?: boolean;
  now?: Date;
  /**
   * Huella de la petición original (ver appointmentRequestHash). Solo la pasa walkIn, cuyo
   * inicio se calcula en el servidor y cambia entre reintentos.
   */
  requestHash?: string;
}

/**
 * Lo que identifica una petición de agendar: la misma clave con otros datos es un conflicto
 * (IdempotencyConflictError), nunca la cita de otra petición.
 */
export function appointmentRequestHash(input: CreateAppointmentInput): string {
  return requestHash({
    kind: "appointment",
    locationId: input.locationId,
    serviceId: input.serviceId,
    staffId: input.staffId,
    start: input.start,
    clientId: input.clientId,
    source: input.source,
    notes: input.notes?.trim() || null,
    allowOutsideHours: input.allowOutsideHours ?? false,
    createdBy: input.createdBy,
  });
}

export interface CreatedAppointment {
  appointmentId: bigint;
  publicId: string;
  staffId: bigint;
  start: Date;
  created: boolean;
}

export async function createAppointment(db: Db, input: CreateAppointmentInput): Promise<CreatedAppointment> {
  const now = input.now ?? new Date();
  if (input.source === "online" && input.allowOutsideHours) throw new BookingError("Las reservas en línea respetan el horario");
  if (input.source !== "walk_in" && input.clientId === null) throw new BookingError("Elige o crea el cliente");
  const hash = input.requestHash ?? appointmentRequestHash(input);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const existing = await findByIdempotencyKey(tx, input.locationId, input.idempotencyKey);
    if (existing) return replayOf(existing, hash);

    await expireHolds(tx, input.locationId, now);
    if (input.source === "online" && input.clientId !== null) {
      // Un cliente tiene una sola retención: la nueva reemplaza la anterior (la base lo exige).
      await cancelPendingHolds(tx, input.locationId, input.clientId);
    }
    const rules = await locationRules(tx, input.locationId);
    const svc = await activeService(tx, input.locationId, input.serviceId);
    const occupied = occupiedRange(input.start, svc.durationMin, svc.bufferMin);

    const candidates = await activeStaff(
      tx,
      input.locationId,
      input.staffId === "any" ? undefined : [input.staffId],
      input.source === "online",
    );
    if (input.staffId !== "any" && candidates.length === 0) throw new BookingError("Ese barbero no está activo");
    const busy = await busyIntervals(tx, { locationId: input.locationId, from: occupied.start, to: occupied.end, now });

    const free = candidates.filter((s) => !overlapsBusy(s.staffId, occupied, busy));
    const inHours = free.filter((s) => input.allowOutsideHours || fitsSchedule(input.start, svc.durationMin, s.blocks, rules.timeZone));
    if (input.staffId !== "any") {
      if (free.length === 0) throw new SlotTakenError();
      if (inHours.length === 0) {
        throw new BookingError(`Ese horario está fuera del turno de ${candidates[0]!.displayName}`);
      }
    }
    let order = inHours.map((s) => s.staffId);
    if (input.staffId === "any") {
      if (order.length === 0) throw new SlotTakenError("Ningún barbero está libre en ese horario");
      const booked = await bookedMinutes(tx, input.locationId, businessDate(input.start, rules.timeZone), rules.timeZone);
      const first = pickStaffForAny(order, booked);
      order = [first, ...order.filter((id) => id !== first)];
    }

    const status = input.source === "online" ? "pending" : input.source === "walk_in" ? "arrived" : "confirmed";
    for (const staffId of order) {
      const publicId = ulid(now.getTime());
      try {
        const appointmentId = await tx.transaction(async (sp) => {
          const [row] = await sp
            .insert(appointments)
            .values({
              locationId: input.locationId,
              publicId,
              staffId,
              serviceId: svc.id,
              clientId: input.clientId,
              serviceName: svc.name,
              durationMin: svc.durationMin,
              bufferMin: svc.bufferMin,
              price: svc.price,
              status,
              source: input.source,
              during: occupied,
              expiresAt: status === "pending" ? new Date(now.getTime() + rules.holdMin * MINUTE_MS) : null,
              notes: input.notes?.trim() || null,
              idempotencyKey: input.idempotencyKey,
              requestHash: hash,
              createdBy: input.createdBy,
            })
            .returning({ id: appointments.id });
          return row!.id;
        });
        await tx.insert(appointmentEvents).values({
          locationId: input.locationId,
          appointmentId,
          kind: "created",
          toStatus: status,
          actorKind: input.source === "online" ? "client" : "staff",
          actorUserId: input.source === "online" ? null : input.createdBy,
          reason: input.allowOutsideHours ? "Agendada fuera del turno (confirmado por el personal)" : null,
        });
        return { appointmentId, publicId, staffId, start: input.start, created: true };
      } catch (err) {
        if (isExclusionViolation(err)) continue; // alguien tomó ese horario un instante antes: probar el siguiente
        if (pgCode(err).constraint === "appointments_idempotency_key") {
          const again = await findByIdempotencyKey(tx, input.locationId, input.idempotencyKey);
          if (again) return replayOf(again, hash);
        }
        throw err;
      }
    }
    throw new SlotTakenError();
  });
}

async function cancelPendingHolds(db: Db, locationId: bigint, clientId: bigint): Promise<void> {
  const replaced = await db
    .update(appointments)
    .set({ status: "cancelled", cancelReason: "duplicate" })
    .where(and(eq(appointments.locationId, locationId), eq(appointments.clientId, clientId), eq(appointments.status, "pending")))
    .returning({ id: appointments.id });
  if (replaced.length > 0) {
    await db.insert(appointmentEvents).values(
      replaced.map((a) => ({
        locationId,
        appointmentId: a.id,
        kind: "status" as const,
        fromStatus: "pending",
        toStatus: "cancelled",
        actorKind: "system" as const,
        reason: "Reemplazada por una reserva nueva del mismo cliente",
      })),
    );
  }
}

async function findByIdempotencyKey(db: Db, locationId: bigint, key: string) {
  const [row] = await db
    .select({
      appointmentId: appointments.id,
      publicId: appointments.publicId,
      staffId: appointments.staffId,
      during: appointments.during,
      requestHash: appointments.requestHash,
    })
    .from(appointments)
    .where(and(eq(appointments.locationId, locationId), eq(appointments.idempotencyKey, key)));
  return row
    ? { appointmentId: row.appointmentId, publicId: row.publicId, staffId: row.staffId, start: row.during.start, requestHash: row.requestHash }
    : undefined;
}

/** Reintento con la misma clave: la cita original si es la misma petición; si no, conflicto. */
function replayOf(existing: NonNullable<Awaited<ReturnType<typeof findByIdempotencyKey>>>, hash: string): CreatedAppointment {
  assertSameRequest(existing, hash);
  const { requestHash: _stored, ...appointment } = existing;
  return { ...appointment, created: false };
}

/** Minutos ya agendados por barbero en un día local (para repartir "Cualquiera"). */
async function bookedMinutes(db: Db, locationId: bigint, date: string, timeZone: string): Promise<Map<bigint, number>> {
  const from = localMinuteToInstant(date, 0, timeZone);
  const to = localMinuteToInstant(addDays(date, 1), 0, timeZone);
  const rows = await db
    .select({ staffId: appointments.staffId, minutes: sql<number>`sum(${appointments.durationMin})::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.locationId, locationId),
        inArray(appointments.status, [...ACTIVE_STATUSES]),
        sql`${appointments.during} && ${range(from, to)}`,
      ),
    )
    .groupBy(appointments.staffId);
  return new Map(rows.map((r) => [r.staffId, Number(r.minutes)]));
}

/** Walk-in: empieza ahora. Si el barbero pedido está ocupado, dice a qué hora se libera. */
export async function walkIn(
  db: Db,
  input: {
    locationId: bigint;
    serviceId: bigint;
    staffId: bigint | "any";
    clientId: bigint | null;
    notes?: string;
    idempotencyKey: string;
    createdBy: string;
    allowOutsideHours?: boolean;
    now?: Date;
  },
): Promise<CreatedAppointment> {
  const now = input.now ?? new Date();
  // La hora la pone el servidor (ahora), así que no entra en la huella: un reintento un minuto
  // después sigue siendo la misma petición.
  const hash = requestHash({
    kind: "walk_in",
    locationId: input.locationId,
    serviceId: input.serviceId,
    staffId: input.staffId,
    clientId: input.clientId,
    notes: input.notes?.trim() || null,
    allowOutsideHours: input.allowOutsideHours ?? false,
    createdBy: input.createdBy,
  });
  // Reintento (respuesta perdida, doble toque): la silla ya la ocupa este mismo walk-in.
  const existing = await findByIdempotencyKey(db, input.locationId, input.idempotencyKey);
  if (existing) return replayOf(existing, hash);
  const rules = await locationRules(db, input.locationId);
  const svc = await activeService(db, input.locationId, input.serviceId);
  const staff = await activeStaff(db, input.locationId, input.staffId === "any" ? undefined : [input.staffId]);
  const plan = planWalkIn({
    now,
    durationMin: svc.durationMin,
    bufferMin: svc.bufferMin,
    staffIds: staff.map((s) => s.staffId),
    busy: await busyIntervals(db, {
      locationId: input.locationId,
      from: new Date(now.getTime() - 24 * 60 * MINUTE_MS),
      to: new Date(now.getTime() + 24 * 60 * MINUTE_MS),
      now,
    }),
  });
  if (plan.freeNow.length === 0) {
    const next = plan.nextFree[0];
    const who = staff.find((s) => s.staffId === next?.staffId)?.displayName;
    throw new SlotTakenError(
      next && who
        ? `${input.staffId === "any" ? "Nadie está libre ahora. " : ""}${who} se libera a las ${formatTime(localMinuteOf(next.at, rules.timeZone))}`
        : "Nadie está libre ahora",
    );
  }
  return createAppointment(db, {
    ...input,
    staffId: input.staffId === "any" ? "any" : input.staffId,
    start: plan.start,
    source: "walk_in",
    now,
    requestHash: hash,
  });
}

// ─── Cambios de estado y reprogramación ──────────────────────────────────────

async function lockAppointment(db: Db, locationId: bigint, appointmentId: bigint) {
  const [row] = await db
    .select({
      id: appointments.id,
      staffId: appointments.staffId,
      status: appointments.status,
      during: appointments.during,
      bufferMin: appointments.bufferMin,
      durationMin: appointments.durationMin,
    })
    .from(appointments)
    .where(and(eq(appointments.locationId, locationId), eq(appointments.id, appointmentId)))
    .for("update");
  if (!row) throw new BookingError("La cita no existe");
  return row;
}

export async function changeStatus(
  db: Db,
  input: {
    locationId: bigint;
    appointmentId: bigint;
    to: AppointmentStatus;
    actor: AgendaActor;
    cancelReason?: CancelReason;
    note?: string;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const appt = await lockAppointment(tx, input.locationId, input.appointmentId);
    const rules = await locationRules(tx, input.locationId);
    const actor = input.actor;
    assertTransition({
      from: appt.status,
      to: input.to,
      actor: "kind" in actor ? actor : { kind: "staff", role: actor.role, ownAppointment: appt.staffId === actor.staffId },
      now,
      appointmentStart: appt.during.start,
      timeZone: rules.timeZone,
      noShowGraceMin: rules.noShowGraceMin,
    });

    const patch: Partial<typeof appointments.$inferInsert> = { status: input.to };
    if (appt.status === "pending") patch.expiresAt = null; // confirmada o cancelada: ya no es una retención
    if (input.to === "cancelled") {
      const reason = input.cancelReason ?? "staff";
      patch.cancelReason = reason;
      patch.cancelNote = input.note?.trim() || null;
      patch.cancelledLate = reason === "client" && isLateCancellation(now, appt.during.start, rules.freeCancelHours);
    }
    if (input.to === "completed") {
      // Terminó antes de lo previsto: la silla queda libre desde ya (más la limpieza).
      const doneAt = Math.ceil(now.getTime() / (5 * MINUTE_MS)) * 5 * MINUTE_MS + appt.bufferMin * MINUTE_MS;
      const end = Math.max(appt.during.start.getTime() + 5 * MINUTE_MS, Math.min(appt.during.end.getTime(), doneAt));
      patch.during = { start: appt.during.start, end: new Date(end) };
    }
    await tx.update(appointments).set(patch).where(eq(appointments.id, appt.id));
    await tx.insert(appointmentEvents).values({
      locationId: input.locationId,
      appointmentId: appt.id,
      kind: "status",
      fromStatus: appt.status,
      toStatus: input.to,
      ...actorFields(actor),
      reason: input.note?.trim() || null,
    });
    // Cancelada o no-show desde el panel: el enlace del cliente deja de servir.
    if (!("kind" in actor) && (input.to === "cancelled" || input.to === "no_show")) {
      await revokeManageLinks(tx, { locationId: input.locationId, appointmentId: appt.id, reason: "staff", now });
    }
  });
}

export async function rescheduleAppointment(
  db: Db,
  input: {
    locationId: bigint;
    appointmentId: bigint;
    start: Date;
    staffId: bigint;
    actor: AgendaActor;
    allowOutsideHours?: boolean;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  if ("kind" in input.actor && input.allowOutsideHours) throw new BookingError("Solo el personal agenda fuera del turno");
  try {
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const appt = await lockAppointment(tx, input.locationId, input.appointmentId);
      if (!["pending", "confirmed", "arrived"].includes(appt.status)) {
        throw new BookingError("Solo se reprograma una cita que todavía no empieza");
      }
      const rules = await locationRules(tx, input.locationId);
      await expireHolds(tx, input.locationId, now);
      const [staff] = await activeStaff(tx, input.locationId, [input.staffId], "kind" in input.actor);
      if (!staff) throw new BookingError("Ese barbero no está activo");
      if (!input.allowOutsideHours && !fitsSchedule(input.start, appt.durationMin, staff.blocks, rules.timeZone)) {
        throw new BookingError(`Ese horario está fuera del turno de ${staff.displayName}`);
      }
      const during: TimeRange = occupiedRange(input.start, appt.durationMin, appt.bufferMin);
      const busy = await busyIntervals(tx, {
        locationId: input.locationId,
        from: during.start,
        to: during.end,
        now,
        excludeAppointmentId: appt.id,
      });
      if (overlapsBusy(input.staffId, during, busy)) throw new SlotTakenError();

      await tx.update(appointments).set({ staffId: input.staffId, during }).where(eq(appointments.id, appt.id));
      await tx.insert(appointmentEvents).values({
        locationId: input.locationId,
        appointmentId: appt.id,
        kind: "rescheduled",
        prevStaffId: appt.staffId,
        prevDuring: appt.during,
        ...actorFields(input.actor),
      });
      // Quien reprograme (personal o cliente): el enlace sigue al nuevo fin de la cita.
      await extendManageLink(tx, { locationId: input.locationId, appointmentId: appt.id, appointmentEnd: during.end });
    });
  } catch (err) {
    if (isExclusionViolation(err)) throw new SlotTakenError();
    throw err;
  }
}

// ─── Agenda del día ──────────────────────────────────────────────────────────

export interface AgendaAppointment {
  id: bigint;
  publicId: string;
  staffId: bigint;
  staffName: string;
  serviceId: bigint;
  clientId: bigint | null;
  clientName: string | null;
  clientPhone: string | null;
  serviceName: string;
  start: Date;
  /** Fin del servicio (sin limpieza): lo que se dibuja. */
  serviceEnd: Date;
  /** Fin de la ocupación (con limpieza). */
  end: Date;
  status: AppointmentStatus;
  source: "staff" | "walk_in" | "online";
  notes: string | null;
  price: Money;
}

export interface AgendaColumn {
  staffId: bigint;
  displayName: string;
  /** Turno de ese día (minutos locales). */
  blocks: ScheduleBlock[];
}

export interface AgendaTimeOff {
  id: bigint;
  staffId: bigint | null;
  start: Date;
  end: Date;
  kind: "absence" | "block";
  reason: string | null;
}

export interface DayAgenda {
  date: string;
  timeZone: string;
  columns: AgendaColumn[];
  appointments: AgendaAppointment[];
  timeOff: AgendaTimeOff[];
}

export async function dayAgenda(db: Db, input: { locationId: bigint; date: string; staffId?: bigint }): Promise<DayAgenda> {
  const rules = await locationRules(db, input.locationId);
  const from = localMinuteToInstant(input.date, 0, rules.timeZone);
  const to = localMinuteToInstant(addDays(input.date, 1), 0, rules.timeZone);
  const weekday = isoWeekday(input.date);

  const rows = await db
    .select({
      id: appointments.id,
      publicId: appointments.publicId,
      staffId: appointments.staffId,
      staffName: staffMembers.displayName,
      serviceId: appointments.serviceId,
      clientId: appointments.clientId,
      clientName: clients.name,
      clientPhone: clients.phoneE164,
      serviceName: appointments.serviceName,
      durationMin: appointments.durationMin,
      during: appointments.during,
      status: appointments.status,
      source: appointments.source,
      notes: appointments.notes,
      price: appointments.price,
    })
    .from(appointments)
    .innerJoin(staffMembers, and(eq(staffMembers.locationId, appointments.locationId), eq(staffMembers.id, appointments.staffId)))
    .leftJoin(clients, and(eq(clients.locationId, appointments.locationId), eq(clients.id, appointments.clientId)))
    .where(
      and(
        eq(appointments.locationId, input.locationId),
        sql`${appointments.during} && ${range(from, to)}`,
        input.staffId ? eq(appointments.staffId, input.staffId) : undefined,
      ),
    )
    .orderBy(sql`lower(${appointments.during})`);

  const off = await db
    .select({ id: timeOff.id, staffId: timeOff.staffId, during: timeOff.during, kind: timeOff.kind, reason: timeOff.reason })
    .from(timeOff)
    .where(and(eq(timeOff.locationId, input.locationId), isNull(timeOff.cancelledAt), sql`${timeOff.during} && ${range(from, to)}`));

  const withAppointments = new Set(rows.map((r) => r.staffId));
  const columns: AgendaColumn[] = (await activeStaff(db, input.locationId, input.staffId ? [input.staffId] : undefined))
    .filter((s) => s.blocks.length > 0 || withAppointments.has(s.staffId))
    .map((s) => ({ staffId: s.staffId, displayName: s.displayName, blocks: s.blocks.filter((b) => b.weekday === weekday) }));
  // Personal ya retirado que aún tiene citas ese día: su columna se muestra (sin turno) para no perderlas.
  for (const r of rows) {
    if (!columns.some((c) => c.staffId === r.staffId)) columns.push({ staffId: r.staffId, displayName: r.staffName, blocks: [] });
  }

  return {
    date: input.date,
    timeZone: rules.timeZone,
    columns,
    appointments: rows.map((r) => ({
      id: r.id,
      publicId: r.publicId,
      staffId: r.staffId,
      staffName: r.staffName,
      serviceId: r.serviceId,
      clientId: r.clientId,
      clientName: r.clientName,
      clientPhone: r.clientPhone,
      serviceName: r.serviceName,
      start: r.during.start,
      serviceEnd: new Date(Math.min(r.during.end.getTime(), r.during.start.getTime() + r.durationMin * MINUTE_MS)),
      end: r.during.end,
      status: r.status,
      source: r.source,
      notes: r.notes,
      price: money(r.price),
    })),
    timeOff: off.map((o) => ({ id: o.id, staffId: o.staffId, start: o.during.start, end: o.during.end, kind: o.kind, reason: o.reason })),
  };
}

export interface AppointmentEventView {
  kind: "created" | "status" | "rescheduled";
  fromStatus: string | null;
  toStatus: string | null;
  actorName: string | null;
  actorKind: "staff" | "client" | "system";
  reason: string | null;
  at: Date;
}

export async function appointmentHistory(
  db: Db,
  input: { locationId: bigint; appointmentId: bigint; /** Solo si la cita es de este barbero. */ staffId?: bigint },
): Promise<AppointmentEventView[]> {
  return db
    .select({
      kind: appointmentEvents.kind,
      fromStatus: appointmentEvents.fromStatus,
      toStatus: appointmentEvents.toStatus,
      actorName: user.name,
      actorKind: appointmentEvents.actorKind,
      reason: appointmentEvents.reason,
      at: appointmentEvents.createdAt,
    })
    .from(appointmentEvents)
    .innerJoin(
      appointments,
      and(eq(appointments.locationId, appointmentEvents.locationId), eq(appointments.id, appointmentEvents.appointmentId)),
    )
    .leftJoin(user, eq(user.id, appointmentEvents.actorUserId))
    .where(
      and(
        eq(appointmentEvents.locationId, input.locationId),
        eq(appointmentEvents.appointmentId, input.appointmentId),
        input.staffId ? eq(appointments.staffId, input.staffId) : undefined,
      ),
    )
    .orderBy(asc(appointmentEvents.id));
}
