"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/db/client";
import { changeOwnPassword, markReauthenticated, verifyUserPassword } from "@/db/credentials";
import { clearReservation, releaseAttempt, reserveAttempt, userThrottleSubject } from "@/db/login-throttle";
import { StaffError } from "@/db/staff";
import type { Db } from "@/db/types";
import { type ActionResult, runAction } from "@/lib/action";
import { auth, MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { requireSignedInStaff, requireStaff, type StaffContext } from "@/lib/session";

// Cuenta propia: cambiar la contraseña (también la temporal del primer ingreso) y confirmar
// identidad antes de una acción crítica, y con el TOTP activo, generar códigos de respaldo nuevos o
// desactivarlo (contraseña Y código). Cada intento se reserva en el bloqueo por cuenta ANTES de
// verificar la credencial (src/db/login-throttle.ts).

const conn = () => db() as unknown as Db;

const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `La contraseña nueva debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`)
  .max(128, "La contraseña es muy larga");

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Escribe tu contraseña actual").max(128),
  newPassword: passwordSchema,
});

/** Cambia la contraseña propia y cierra las demás sesiones. Vale con la contraseña temporal pendiente. */
export async function changeOwnPasswordAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requireSignedInStaff();
    const input = changePasswordSchema.parse(raw);
    if (!staff.sessionId) throw new StaffError("Tu sesión terminó. Vuelve a ingresar.");
    // El intento se reserva ANTES de verificar: N peticiones en paralelo no prueban más de 5 claves.
    const reservation = await reserveAttempt(conn(), [{ subject: userThrottleSubject("password", staff.userId), kind: "password" }]);
    let ok: boolean;
    try {
      ok = await changeOwnPassword(conn(), {
        userId: staff.userId,
        sessionId: staff.sessionId,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      });
    } catch (err) {
      // La nueva no sirve (igual a la actual): no se probó ninguna contraseña, el intento se devuelve.
      await releaseAttempt(conn(), reservation);
      throw err;
    }
    if (!ok) throw new StaffError("La contraseña actual no es correcta.");
    await clearReservation(conn(), reservation);
    // Acaba de demostrar su contraseña: cuenta como reautenticación, salvo con el TOTP activo (ahí
    // solo confirma el código; la contraseña sola no basta).
    if (!staff.twoFactorEnabled) await markReauthenticated(conn(), { userId: staff.userId, sessionId: staff.sessionId });
    return undefined;
  });
}

const reauthSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("password"), password: z.string().min(1, "Escribe tu contraseña").max(128) }),
  z.object({ method: z.literal("totp"), code: z.string().trim().regex(/^\d{6}$/, "El código tiene 6 dígitos") }),
  z.object({ method: z.literal("backup"), code: z.string().trim().min(1, "Escribe un código de respaldo").max(32, "El código de respaldo es muy largo") }),
]);

/**
 * Confirma identidad para las acciones críticas de los próximos minutos (ver requireRecentAuth).
 * Con la verificación en dos pasos activa solo vale el código de la app o uno de respaldo (la
 * contraseña sola no basta); sin ella, la contraseña. El intento se reserva antes de verificar y
 * tras 5 fallos seguidos se bloquea con espera creciente.
 */
export async function reauthenticateAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requireStaff();
    const input = reauthSchema.parse(raw);
    if (!staff.sessionId) throw new StaffError("Tu sesión terminó. Vuelve a ingresar.");
    if (staff.twoFactorEnabled && input.method === "password") {
      throw new StaffError("Tienes la verificación en dos pasos activa: confirma con el código de tu app o un código de respaldo.");
    }
    if (!staff.twoFactorEnabled && input.method !== "password") {
      throw new StaffError("No tienes la verificación en dos pasos activa. Usa tu contraseña.");
    }
    const reservation = await reserveAttempt(conn(), [{ subject: userThrottleSubject("reauth", staff.userId), kind: "reauth" }]);

    const ok = input.method === "password" ? await verifyUserPassword(conn(), staff.userId, input.password) : await verifyCode(input.method, input.code);
    if (!ok) throw new StaffError(input.method === "password" ? "La contraseña no es correcta." : wrongCodeMessage(input.method));
    await clearReservation(conn(), reservation);
    await markReauthenticated(conn(), { userId: staff.userId, sessionId: staff.sessionId });
    return undefined;
  });
}

const wrongCodeMessage = (method: "totp" | "backup") =>
  method === "totp" ? "El código no es correcto." : "El código de respaldo no es correcto o ya se usó.";

/**
 * Código de la app o de respaldo de quien tiene sesión. better-auth lo verifica contra el secreto de
 * esta persona; un código de respaldo se gasta. Se llama desde el servidor (sin `request`): el hook
 * que cierra estos endpoints por HTTP a quien ya tiene el TOTP activo no aplica aquí (src/lib/auth.ts).
 * El llamador reserva el intento antes.
 */
async function verifyCode(method: "totp" | "backup", code: string): Promise<boolean> {
  try {
    const api = (await auth()).api;
    const requestHeaders = await headers();
    if (method === "totp") await api.verifyTOTP({ body: { code }, headers: requestHeaders });
    else await api.verifyBackupCode({ body: { code, disableSession: true }, headers: requestHeaders });
    return true;
  } catch {
    return false;
  }
}

const twoFactorChangeSchema = z.object({
  password: z.string().min(1, "Escribe tu contraseña").max(128),
  code: z.string().trim().min(1, "Escribe el código de tu app o uno de respaldo").max(32, "El código es muy largo"),
});

/**
 * Antes de tocar el TOTP: la contraseña (bloqueo "password") y un código de la app o de respaldo
 * (bloqueo "reauth"), cada intento reservado antes de verificar. La contraseña va primero para no
 * gastar un código de respaldo si estaba mal.
 */
async function confirmPasswordAndCode(staff: StaffContext, input: z.infer<typeof twoFactorChangeSchema>): Promise<void> {
  if (!staff.twoFactorEnabled) throw new StaffError("No tienes la verificación en dos pasos activa.");
  const password = await reserveAttempt(conn(), [{ subject: userThrottleSubject("password", staff.userId), kind: "password" }]);
  if (!(await verifyUserPassword(conn(), staff.userId, input.password))) throw new StaffError("La contraseña no es correcta.");
  await clearReservation(conn(), password);
  const method = /^[0-9]{6}$/.test(input.code) ? "totp" : "backup";
  const code = await reserveAttempt(conn(), [{ subject: userThrottleSubject("reauth", staff.userId), kind: "reauth" }]);
  if (!(await verifyCode(method, input.code))) throw new StaffError(wrongCodeMessage(method));
  await clearReservation(conn(), code);
}

/** Códigos de respaldo nuevos (los anteriores dejan de servir). Pide contraseña y código. */
export async function regenerateBackupCodesAction(raw: unknown): Promise<ActionResult<{ backupCodes: string[] }>> {
  return runAction(async () => {
    const staff = await requireStaff();
    const input = twoFactorChangeSchema.parse(raw);
    await confirmPasswordAndCode(staff, input);
    // Desde el servidor: el hook vuelve a pasar la contraseña por su bloqueo (src/lib/auth.ts).
    const res = await (await auth()).api.generateBackupCodes({ body: { password: input.password }, headers: await headers() });
    return { backupCodes: res.backupCodes };
  });
}

/** Desactiva la verificación en dos pasos propia. Pide contraseña y código. */
export async function disableTwoFactorAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requireStaff();
    const input = twoFactorChangeSchema.parse(raw);
    await confirmPasswordAndCode(staff, input);
    await (await auth()).api.disableTwoFactor({ body: { password: input.password }, headers: await headers() });
    return undefined;
  });
}
