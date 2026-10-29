import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { BookingError } from "@/domain/booking/appointment";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { ACTIVE_STATUSES } from "@/domain/booking/status";
import { locationRules } from "./appointments";
import { appointments, timeOff } from "./schema";
import type { Db } from "./types";

// Ausencias (vacaciones, incapacidad), bloqueos (almuerzo extendido, diligencia) y cierres de
// toda la sede (staffId null, p. ej. festivos). No se borran: se anulan con cancelled_at.

export type TimeOffInput = {
  locationId: bigint;
  staffId: bigint | null;
  kind: "absence" | "block";
  reason?: string;
  createdBy: string;
} & ({ allDay: true; fromDate: string; toDate: string } | { allDay: false; start: Date; end: Date });

/** Crea la ausencia y devuelve cuántas citas activas quedan dentro, para avisar antes de confirmar. */
export async function addTimeOff(db: Db, input: TimeOffInput): Promise<{ id: bigint; overlappingAppointments: number }> {
  const { timeZone } = await locationRules(db, input.locationId);
  const during = input.allDay
    ? {
        start: localMinuteToInstant(input.fromDate, 0, timeZone),
        end: localMinuteToInstant(addDays(input.toDate, 1), 0, timeZone),
      }
    : { start: input.start, end: input.end };
  if (during.end.getTime() <= during.start.getTime()) throw new BookingError("El fin debe ser después del inicio");

  const [row] = await db
    .insert(timeOff)
    .values({
      locationId: input.locationId,
      staffId: input.staffId,
      during,
      allDay: input.allDay,
      kind: input.kind,
      reason: input.reason?.trim() || null,
      createdBy: input.createdBy,
    })
    .returning({ id: timeOff.id });

  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.locationId, input.locationId),
        input.staffId === null ? undefined : eq(appointments.staffId, input.staffId),
        inArray(appointments.status, [...ACTIVE_STATUSES]),
        sql`${appointments.during} && tstzrange(${during.start.toISOString()}::timestamptz, ${during.end.toISOString()}::timestamptz, '[)')`,
      ),
    );
  return { id: row!.id, overlappingAppointments: Number(n) };
}

/** De quién es una ausencia vigente: su staffId, null si es un cierre de la sede, undefined si no existe. */
export async function timeOffStaff(db: Db, input: { locationId: bigint; timeOffId: bigint }): Promise<bigint | null | undefined> {
  const [row] = await db
    .select({ staffId: timeOff.staffId })
    .from(timeOff)
    .where(and(eq(timeOff.locationId, input.locationId), eq(timeOff.id, input.timeOffId), isNull(timeOff.cancelledAt)));
  return row ? row.staffId : undefined;
}

/** Anula una ausencia. Con staffId, solo si es de esa persona (el barbero anula lo suyo). */
export async function cancelTimeOff(db: Db, input: { locationId: bigint; timeOffId: bigint; staffId?: bigint }): Promise<void> {
  const updated = await db
    .update(timeOff)
    .set({ cancelledAt: sql`now()` })
    .where(
      and(
        eq(timeOff.locationId, input.locationId),
        eq(timeOff.id, input.timeOffId),
        isNull(timeOff.cancelledAt),
        input.staffId === undefined ? undefined : eq(timeOff.staffId, input.staffId),
      ),
    )
    .returning({ id: timeOff.id });
  if (updated.length === 0) throw new BookingError("La ausencia no existe o ya fue anulada");
}

export async function listTimeOff(db: Db, input: { locationId: bigint; staffId?: bigint; from: Date }) {
  return db
    .select({
      id: timeOff.id,
      staffId: timeOff.staffId,
      during: timeOff.during,
      allDay: timeOff.allDay,
      kind: timeOff.kind,
      reason: timeOff.reason,
    })
    .from(timeOff)
    .where(
      and(
        eq(timeOff.locationId, input.locationId),
        isNull(timeOff.cancelledAt),
        input.staffId ? eq(timeOff.staffId, input.staffId) : undefined,
        sql`upper(${timeOff.during}) > ${input.from.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(sql`lower(${timeOff.during})`));
}
