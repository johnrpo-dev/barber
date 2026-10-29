"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/db/client";
import { changeOwnPassword, markReauthenticated, verifyUserPassword } from "@/db/credentials";
import { assertNotLocked, clearFailures, recordFailure, userThrottleSubject } from "@/db/login-throttle";
import { StaffError } from "@/db/staff";
import type { Db } from "@/db/types";
import { type ActionResult, runAction } from "@/lib/action";
import { auth, MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { requireSignedInStaff, requireStaff } from "@/lib/session";

// Cuenta propia: cambiar la contraseña (también la temporal del primer ingreso) y confirmar
// identidad antes de una acción crítica. Los fallos cuentan para el bloqueo por cuenta.

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
    const subject = userThrottleSubject("password", staff.userId);
    await assertNotLocked(conn(), subject);
    const ok = await changeOwnPassword(conn(), {
      userId: staff.userId,
      sessionId: staff.sessionId,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });
    if (!ok) {
      await recordFailure(conn(), subject);
      throw new StaffError("La contraseña actual no es correcta.");
    }
    await clearFailures(conn(), subject);
    // Acaba de demostrar su contraseña: cuenta como reautenticación.
    await markReauthenticated(conn(), { userId: staff.userId, sessionId: staff.sessionId });
    return undefined;
  });
}

const reauthSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("password"), password: z.string().min(1, "Escribe tu contraseña").max(128) }),
  z.object({ method: z.literal("totp"), code: z.string().trim().regex(/^\d{6}$/, "El código tiene 6 dígitos") }),
]);

/**
 * Confirma identidad (contraseña o código de la app) para las acciones críticas de los próximos
 * minutos (ver requireRecentAuth). Tras 5 fallos seguidos se bloquea con espera creciente.
 */
export async function reauthenticateAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requireStaff();
    const input = reauthSchema.parse(raw);
    if (!staff.sessionId) throw new StaffError("Tu sesión terminó. Vuelve a ingresar.");
    const subject = userThrottleSubject("reauth", staff.userId);
    await assertNotLocked(conn(), subject);

    let ok: boolean;
    if (input.method === "password") {
      ok = await verifyUserPassword(conn(), staff.userId, input.password);
    } else {
      if (!staff.twoFactorEnabled) throw new StaffError("No tienes la verificación en dos pasos activa. Usa tu contraseña.");
      try {
        // Con sesión activa, better-auth verifica el código contra el secreto de esta persona.
        await (await auth()).api.verifyTOTP({ body: { code: input.code }, headers: await headers() });
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      await recordFailure(conn(), subject);
      throw new StaffError(input.method === "password" ? "La contraseña no es correcta." : "El código no es correcto.");
    }
    await clearFailures(conn(), subject);
    await markReauthenticated(conn(), { userId: staff.userId, sessionId: staff.sessionId });
    return undefined;
  });
}
