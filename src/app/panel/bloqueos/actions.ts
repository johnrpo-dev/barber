"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db/client";
import { locationRules } from "@/db/appointments";
import { StaffError, staffMember } from "@/db/staff";
import { addTimeOff, cancelTimeOff, timeOffStaff } from "@/db/time-off";
import type { Db } from "@/db/types";
import { BookingError } from "@/domain/booking/appointment";
import { addDays, isDateString, localMinuteToInstant } from "@/domain/booking/clock";
import { can } from "@/domain/staff/roles";
import { parseTime } from "@/domain/staff/schedule";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { requirePermission, requireStaff, type StaffContext } from "@/lib/session";

// Ausencias, bloqueos y cierres de la sede. Dueño y recepción manejan los de cualquiera
// (time_off.manage.all); el barbero solo bloquea su propio tiempo (time_off.manage.own).
// La sede sale siempre de la sesión, nunca del cliente.

const conn = () => db() as unknown as Db;
const DENIED = "/panel?sin-permiso=1";

function revalidateTimeOff(staffId?: bigint | null) {
  for (const path of ["/panel/bloqueos", "/panel/personal", "/panel/agenda", "/panel/mi-dia"]) revalidatePath(path);
  if (staffId) revalidatePath(`/panel/personal/${staffId}`);
}

/** Alguien que maneje ausencias, propias o de todos; el resto vuelve al panel. */
async function requireTimeOffStaff(): Promise<StaffContext> {
  const staff = await requireStaff();
  if (!can(staff.role, "time_off.manage.all") && !can(staff.role, "time_off.manage.own")) redirect(DENIED);
  return staff;
}

/** Sin time_off.manage.all solo se toca el tiempo propio (y nunca un cierre de la sede). */
function requireOwnOrAll(staff: StaffContext, staffId: bigint | null) {
  if (can(staff.role, "time_off.manage.all")) return;
  if (staffId === null || staffId !== staff.staffId) redirect(DENIED);
}

const dateSchema = z.string().refine(isDateString, "Fecha inválida");
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, "Completa las horas (HH:MM)");
const MAX_DAYS = 366;

const rangeSchema = z.discriminatedUnion("allDay", [
  z.object({ allDay: z.literal(true), fromDate: dateSchema, toDate: dateSchema }),
  z.object({ allDay: z.literal(false), date: dateSchema, startTime: timeSchema, endTime: timeSchema }),
]);
type RangeInput = z.infer<typeof rangeSchema>;

const reasonSchema = z.string().trim().max(200, "El motivo es muy largo").optional();

/** Traduce lo que escribió el usuario (hora local de la sede) a lo que espera addTimeOff. */
async function toTimeOffRange(locationId: bigint, range: RangeInput) {
  if (range.allDay) {
    if (range.toDate < range.fromDate) throw new BookingError("La fecha final debe ser igual o posterior a la inicial");
    if (addDays(range.fromDate, MAX_DAYS) <= range.toDate) throw new BookingError("El rango no puede pasar de un año");
    return { allDay: true as const, fromDate: range.fromDate, toDate: range.toDate };
  }
  const startMin = parseTime(range.startTime);
  const endMin = parseTime(range.endTime);
  if (endMin <= startMin) throw new BookingError("La hora final debe ser después de la inicial");
  const { timeZone } = await locationRules(conn(), locationId);
  return {
    allDay: false as const,
    start: localMinuteToInstant(range.date, startMin, timeZone),
    end: localMinuteToInstant(range.date, endMin, timeZone),
  };
}

const staffTimeOffSchema = z.object({
  staffId: idSchema,
  kind: z.enum(["absence", "block"], "Elige el tipo"),
  reason: reasonSchema,
  range: rangeSchema,
});

export async function addStaffTimeOffAction(raw: unknown): Promise<ActionResult<{ overlappingAppointments: number }>> {
  return runAction(async () => {
    const staff = await requireTimeOffStaff();
    const input = staffTimeOffSchema.parse(raw);
    requireOwnOrAll(staff, input.staffId);
    // El barbero bloquea su tiempo; las ausencias (vacaciones, incapacidad) las registra la sede.
    if (!can(staff.role, "time_off.manage.all") && input.kind !== "block") redirect(DENIED);
    if (!(await staffMember(conn(), { locationId: staff.locationId, staffId: input.staffId }))) {
      throw new StaffError("La persona no existe en esta sede");
    }
    const range = await toTimeOffRange(staff.locationId, input.range);
    const { overlappingAppointments } = await addTimeOff(conn(), {
      locationId: staff.locationId,
      staffId: input.staffId,
      kind: input.kind,
      reason: input.reason,
      createdBy: staff.userId,
      ...range,
    });
    revalidateTimeOff(input.staffId);
    return { overlappingAppointments };
  });
}

const closureSchema = z.object({
  reason: reasonSchema,
  fromDate: dateSchema,
  toDate: dateSchema,
});

/** Cierre de toda la sede (festivo, remodelación): staffId null, día completo. */
export async function addClosureAction(raw: unknown): Promise<ActionResult<{ overlappingAppointments: number }>> {
  return runAction(async () => {
    const staff = await requirePermission("time_off.manage.all");
    const input = closureSchema.parse(raw);
    const range = await toTimeOffRange(staff.locationId, { allDay: true, fromDate: input.fromDate, toDate: input.toDate });
    const { overlappingAppointments } = await addTimeOff(conn(), {
      locationId: staff.locationId,
      staffId: null,
      kind: "absence",
      reason: input.reason,
      createdBy: staff.userId,
      ...range,
    });
    revalidateTimeOff();
    return { overlappingAppointments };
  });
}

const cancelSchema = z.object({ timeOffId: idSchema });

/** Anula (no borra) una ausencia, bloqueo o cierre de la sede. */
export async function cancelTimeOffAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requireTimeOffStaff();
    const input = cancelSchema.parse(raw);
    const owner = await timeOffStaff(conn(), { locationId: staff.locationId, timeOffId: input.timeOffId });
    if (owner === undefined) throw new BookingError("La ausencia no existe o ya fue anulada");
    requireOwnOrAll(staff, owner);
    await cancelTimeOff(conn(), {
      locationId: staff.locationId,
      timeOffId: input.timeOffId,
      // Defensa en profundidad: sin permiso global, la anulación solo alcanza filas propias.
      ...(can(staff.role, "time_off.manage.all") ? {} : { staffId: staff.staffId }),
    });
    revalidateTimeOff(owner);
    return undefined;
  });
}
