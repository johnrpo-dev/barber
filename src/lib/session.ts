import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db/client";
import { sessionAuthInfo } from "@/db/credentials";
import { membershipsForUser, type StaffMembership } from "@/db/staff";
import type { Db } from "@/db/types";
import { isRecentAuth, lastAuthAt, ReauthRequiredError } from "@/domain/security/reauth";
import { can, type Permission, requiredAccountSetup } from "@/domain/staff/roles";
import { auth } from "./auth";

// Contexto del personal en el servidor. Todo permiso se decide aquí, nunca en el cliente:
// ocultar un botón es comodidad, no seguridad.

export interface StaffContext extends StaffMembership {
  userId: string;
  name: string;
  email: string;
  /** Sesión de better-auth (para reautenticar y para no cerrar la propia al cambiar la contraseña). */
  sessionId: string | null;
  twoFactorEnabled: boolean;
  /** Contraseña temporal pendiente de cambiar. */
  mustChangePassword: boolean;
  /** Última prueba de identidad: el ingreso o la última reautenticación. */
  lastAuthAt: Date | null;
}

type SessionState = { status: "anonymous" } | { status: "no-access" } | { status: "staff"; staff: StaffContext };

/** Dónde se completa lo que falta antes de usar el panel (fuera de /panel, sin sus guardas). */
export const SETUP_PATHS = { password: "/cuenta/clave", "two-factor": "/cuenta/verificacion" } as const;

/** Una sola consulta por petición, aunque varios componentes la pidan. */
export const sessionState = cache(async (): Promise<SessionState> => {
  // headers() primero: marca la página como dinámica antes de tocar la configuración,
  // así `next build` no intenta prerenderizarla ni exige los secretos.
  const requestHeaders = await headers();
  const session = await (await auth()).api.getSession({ headers: requestHeaders });
  if (!session) return { status: "anonymous" };
  const conn = db() as unknown as Db;
  // Una sede por ahora; con varias, aquí se elegiría la sede activa.
  const [membership] = await membershipsForUser(conn, session.user.id);
  if (!membership) return { status: "no-access" };
  const sessionId = (session as { session?: { id?: string } }).session?.id ?? null;
  // Se relee de la base en cada petición: desactivar el TOTP o reiniciar la contraseña se nota al instante.
  const info = await sessionAuthInfo(conn, { userId: session.user.id, sessionId });
  return {
    status: "staff",
    staff: {
      ...membership,
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email,
      sessionId,
      twoFactorEnabled: info.twoFactorEnabled,
      mustChangePassword: info.mustChangePassword,
      lastAuthAt: lastAuthAt(info.sessionCreatedAt, info.reauthenticatedAt),
    },
  };
});

/**
 * Personal con sesión y membresía activa, aunque le falte cambiar la contraseña temporal o
 * inscribir la verificación en dos pasos. Solo para las pantallas que completan eso (/cuenta).
 */
export async function requireSignedInStaff(): Promise<StaffContext> {
  const state = await sessionState();
  if (state.status === "anonymous") redirect("/ingresar");
  if (state.status === "no-access") redirect("/ingresar?sin-acceso=1");
  return state.staff;
}

/** Personal listo para usar el panel: si falta la contraseña nueva o el TOTP (dueño), va a completarlo. */
export async function requireStaff(): Promise<StaffContext> {
  const staff = await requireSignedInStaff();
  const setup = requiredAccountSetup(staff);
  if (setup) redirect(SETUP_PATHS[setup]);
  return staff;
}

export async function requirePermission(permission: Permission): Promise<StaffContext> {
  const staff = await requireStaff();
  if (!can(staff.role, permission)) redirect("/panel?sin-permiso=1");
  return staff;
}

/**
 * Acciones críticas (crear o ascender dueños, cambiar roles, contraseñas del personal y, en el
 * sprint 4, reabrir un día o aprobar reversas): exige haber confirmado identidad hace poco.
 * Si no, lanza ReauthRequiredError y la interfaz pide la contraseña o el código y reintenta.
 * Se llama DESPUÉS de requirePermission y ANTES de escribir nada.
 */
export function requireRecentAuth(staff: StaffContext, now: Date = new Date()): void {
  if (!isRecentAuth(staff.lastAuthAt, now)) throw new ReauthRequiredError();
}
