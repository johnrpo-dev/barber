"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db/client";
import { locationRules } from "@/db/appointments";
import {
  addStaffMember,
  createStaffUser,
  setStaffActive,
  setWeeklySchedule,
  StaffError,
  staffMember,
  updateStaffMember,
} from "@/db/staff";
import { addTimeOff, cancelTimeOff } from "@/db/time-off";
import type { Db } from "@/db/types";
import { BookingError } from "@/domain/booking/appointment";
import { addDays, isDateString, localMinuteToInstant } from "@/domain/booking/clock";
import { ROLES } from "@/domain/staff/roles";
import { parseTime, type Weekday } from "@/domain/staff/schedule";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { requirePermission } from "@/lib/session";

// Personal, horarios, ausencias y cierres de la sede.
// Cada acción verifica su permiso en el servidor y toma la sede de la sesión, nunca del cliente.

const conn = () => db() as unknown as Db;

function revalidateStaff(staffId?: bigint) {
  revalidatePath("/panel/personal");
  if (staffId !== undefined) revalidatePath(`/panel/personal/${staffId}`);
}

/** Que la persona exista en la sede de quien opera (si no, el id viene de otra sede o no existe). */
async function requireMember(locationId: bigint, staffId: bigint) {
  const member = await staffMember(conn(), { locationId, staffId });
  if (!member) throw new StaffError("La persona no existe en esta sede");
  return member;
}

// ─── Personal ────────────────────────────────────────────────────────────────

const nameSchema = z.string().trim().min(2, "El nombre debe tener al menos 2 caracteres").max(80, "El nombre es muy largo");
const roleSchema = z.enum(ROLES, "Elige un rol");

const createStaffSchema = z.discriminatedUnion("withAccess", [
  z.object({ withAccess: z.literal(false), name: nameSchema, role: roleSchema }),
  z.object({
    withAccess: z.literal(true),
    name: nameSchema,
    role: roleSchema,
    email: z.string().trim().max(200).email("El correo no es válido"),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `La contraseña temporal debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`)
      .max(128, "La contraseña es muy larga"),
  }),
]);

export async function createStaffAction(raw: unknown): Promise<ActionResult<{ staffId: string }>> {
  return runAction(async () => {
    const staff = await requirePermission("staff.manage");
    const input = createStaffSchema.parse(raw);
    if (!input.withAccess) {
      const staffId = await addStaffMember(conn(), { locationId: staff.locationId, displayName: input.name, role: input.role });
      revalidateStaff();
      return { staffId: staffId.toString() };
    }
    try {
      const { staffId } = await createStaffUser(conn(), {
        locationId: staff.locationId,
        name: input.name,
        email: input.email,
        password: input.password,
        role: input.role,
      });
      revalidateStaff();
      return { staffId: staffId.toString() };
    } catch (err) {
      for (let e: unknown = err; e instanceof Error; e = (e as Error & { cause?: unknown }).cause) {
        if (e.message.includes("user_email_unique")) throw new StaffError("Ya existe una cuenta con ese correo");
      }
      throw err;
    }
  });
}

const profileSchema = z.object({ staffId: idSchema, displayName: nameSchema, role: roleSchema, active: z.boolean() });

export async function updateStaffProfileAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("staff.manage");
    const input = profileSchema.parse(raw);
    if (input.staffId === staff.staffId && (!input.active || input.role !== "owner")) {
      // Evita que el dueño se quite a sí mismo el acceso a esta pantalla por accidente.
      throw new StaffError("No puedes retirarte ni quitarte el rol de dueño a ti mismo");
    }
    await conn().transaction(async (tx) => {
      const t = tx as unknown as Db;
      await updateStaffMember(t, {
        locationId: staff.locationId,
        staffId: input.staffId,
        displayName: input.displayName,
        role: input.role,
      });
      await setStaffActive(t, { locationId: staff.locationId, staffId: input.staffId, active: input.active });
    });
    revalidateStaff(input.staffId);
    return undefined;
  });
}

// ─── Horario semanal ─────────────────────────────────────────────────────────

const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, "Completa las horas (HH:MM)");

const scheduleSchema = z.object({
  staffId: idSchema,
  blocks: z
    .array(z.object({ weekday: z.number().int().min(1).max(7), start: timeSchema, end: timeSchema }))
    .max(7 * 6, "Demasiados turnos en la semana"),
});

export async function saveScheduleAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("schedules.manage.all");
    const input = scheduleSchema.parse(raw);
    await requireMember(staff.locationId, input.staffId);
    // setWeeklySchedule valida con assertValidWeeklySchedule (cruces, múltiplos de 5) y reemplaza todo en una transacción.
    await setWeeklySchedule(conn(), {
      locationId: staff.locationId,
      staffId: input.staffId,
      blocks: input.blocks.map((b) => ({
        weekday: b.weekday as Weekday,
        startMin: parseTime(b.start),
        endMin: parseTime(b.end),
      })),
    });
    revalidateStaff(input.staffId);
    return undefined;
  });
}

// ─── Ausencias, bloqueos y cierres ───────────────────────────────────────────

const dateSchema = z.string().refine(isDateString, "Fecha inválida");
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
    const staff = await requirePermission("time_off.manage.all");
    const input = staffTimeOffSchema.parse(raw);
    await requireMember(staff.locationId, input.staffId);
    const range = await toTimeOffRange(staff.locationId, input.range);
    const { overlappingAppointments } = await addTimeOff(conn(), {
      locationId: staff.locationId,
      staffId: input.staffId,
      kind: input.kind,
      reason: input.reason,
      createdBy: staff.userId,
      ...range,
    });
    revalidateStaff(input.staffId);
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
    revalidateStaff();
    return { overlappingAppointments };
  });
}

const cancelSchema = z.object({ timeOffId: idSchema, staffId: idSchema.optional() });

/** Anula (no borra) una ausencia, bloqueo o cierre de la sede. */
export async function cancelTimeOffAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("time_off.manage.all");
    const input = cancelSchema.parse(raw);
    await cancelTimeOff(conn(), { locationId: staff.locationId, timeOffId: input.timeOffId });
    revalidateStaff(input.staffId);
    return undefined;
  });
}
