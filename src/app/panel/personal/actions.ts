"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db/client";
import { resetStaffPassword, revokeStaffSessions } from "@/db/credentials";
import {
  addStaffMember,
  createStaffUser,
  setStaffActive,
  setWeeklySchedule,
  StaffError,
  staffMember,
  updateStaffMember,
} from "@/db/staff";
import type { Db } from "@/db/types";
import { ROLES } from "@/domain/staff/roles";
import { parseTime, type Weekday } from "@/domain/staff/schedule";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { requirePermission, requireRecentAuth } from "@/lib/session";

// Personal y horarios. Las ausencias, bloqueos y cierres están en ../bloqueos/actions.
// Cada acción verifica su permiso en el servidor y toma la sede de la sesión, nunca del cliente.
// Crear o ascender dueños, cambiar roles y poner contraseñas exigen reautenticación reciente.

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
    // Un dueño nuevo tiene acceso total a las cuentas: confirmar identidad antes de crearlo.
    if (input.role === "owner") requireRecentAuth(staff);
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
        // La eligió el dueño: debe cambiarla en su primer ingreso.
        mustChangePassword: true,
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
    const current = await requireMember(staff.locationId, input.staffId);
    // Críticos: cambiar un rol (sobre todo ascender a dueño) y tocar a un dueño (su nombre, que
    // aparece en las cuentas, o retirarlo/reactivarlo). Confirmar identidad.
    if (current.role !== input.role || current.role === "owner" || input.role === "owner") requireRecentAuth(staff);
    // Retirar a alguien también cierra sus sesiones (setStaffActive), en la misma transacción.
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

// ─── Acceso a la app ─────────────────────────────────────────────────────────

const resetPasswordSchema = z.object({
  staffId: idSchema,
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `La contraseña temporal debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`)
    .max(128, "La contraseña es muy larga"),
});

/**
 * Contraseña temporal nueva para alguien del personal (la olvidó o se filtró). Debe cambiarla al
 * ingresar y se cierran todas sus sesiones. Exige reautenticación reciente.
 */
export async function resetStaffPasswordAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("staff.manage");
    const input = resetPasswordSchema.parse(raw);
    if (input.staffId === staff.staffId) throw new StaffError("Para cambiar tu propia contraseña usa “Mi cuenta”");
    await requireMember(staff.locationId, input.staffId);
    requireRecentAuth(staff);
    await resetStaffPassword(conn(), { locationId: staff.locationId, staffId: input.staffId, password: input.password });
    revalidateStaff(input.staffId);
    return undefined;
  });
}

const revokeSchema = z.object({ staffId: idSchema });

/** Cierra todas las sesiones de alguien del personal (p. ej. perdió el celular). */
export async function revokeStaffSessionsAction(raw: unknown): Promise<ActionResult<{ closed: number }>> {
  return runAction(async () => {
    const staff = await requirePermission("staff.manage");
    const input = revokeSchema.parse(raw);
    if (input.staffId === staff.staffId) throw new StaffError("Para cerrar tu propia sesión usa “Salir”");
    const closed = await revokeStaffSessions(conn(), { locationId: staff.locationId, staffId: input.staffId });
    return { closed };
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
