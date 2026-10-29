import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db/client";
import { membershipsForUser, type StaffMembership } from "@/db/staff";
import type { Db } from "@/db/types";
import { can, type Permission } from "@/domain/staff/roles";
import { auth } from "./auth";

// Contexto del personal en el servidor. Todo permiso se decide aquí, nunca en el cliente:
// ocultar un botón es comodidad, no seguridad.

export interface StaffContext extends StaffMembership {
  userId: string;
  name: string;
  email: string;
}

type SessionState = { status: "anonymous" } | { status: "no-access" } | { status: "staff"; staff: StaffContext };

/** Una sola consulta por petición, aunque varios componentes la pidan. */
export const sessionState = cache(async (): Promise<SessionState> => {
  // headers() primero: marca la página como dinámica antes de tocar la configuración,
  // así `next build` no intenta prerenderizarla ni exige los secretos.
  const requestHeaders = await headers();
  const session = await (await auth()).api.getSession({ headers: requestHeaders });
  if (!session) return { status: "anonymous" };
  // Una sede por ahora; con varias, aquí se elegiría la sede activa.
  const [membership] = await membershipsForUser(db() as unknown as Db, session.user.id);
  if (!membership) return { status: "no-access" };
  return { status: "staff", staff: { ...membership, userId: session.user.id, name: session.user.name, email: session.user.email } };
});

export async function requireStaff(): Promise<StaffContext> {
  const state = await sessionState();
  if (state.status === "anonymous") redirect("/ingresar");
  if (state.status === "no-access") redirect("/ingresar?sin-acceso=1");
  return state.staff;
}

export async function requirePermission(permission: Permission): Promise<StaffContext> {
  const staff = await requireStaff();
  if (!can(staff.role, permission)) redirect("/panel?sin-permiso=1");
  return staff;
}
