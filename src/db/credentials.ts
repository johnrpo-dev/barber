import { and, eq, ne } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { account, session, staffMembers, user } from "./schema";
import { StaffError } from "./staff";
import type { Db } from "./types";

// Contraseñas y sesiones del personal, directo en la base (mismo formato que better-auth:
// scrypt en account.password con provider "credential"). Cada cambio cierra las sesiones que
// correspondan en la misma transacción.

const CREDENTIAL = "credential";

/** Estado de seguridad de una sesión: lo que el servidor exige antes de dejar usar el panel. */
export interface SessionAuthInfo {
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  sessionCreatedAt: Date | null;
  reauthenticatedAt: Date | null;
}

export async function sessionAuthInfo(db: Db, input: { userId: string; sessionId: string | null }): Promise<SessionAuthInfo> {
  const [u] = await db
    .select({ twoFactorEnabled: user.twoFactorEnabled, mustChangePassword: user.mustChangePassword })
    .from(user)
    .where(eq(user.id, input.userId));
  const [s] = input.sessionId
    ? await db
        .select({ createdAt: session.createdAt, reauthenticatedAt: session.reauthenticatedAt })
        .from(session)
        .where(and(eq(session.id, input.sessionId), eq(session.userId, input.userId)))
    : [];
  return {
    twoFactorEnabled: u?.twoFactorEnabled ?? false,
    mustChangePassword: u?.mustChangePassword ?? false,
    sessionCreatedAt: s?.createdAt ?? null,
    reauthenticatedAt: s?.reauthenticatedAt ?? null,
  };
}

/** ¿Es su contraseña? (comparación en tiempo constante dentro de scrypt). */
export async function verifyUserPassword(db: Db, userId: string, password: string): Promise<boolean> {
  const [row] = await db
    .select({ hash: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, CREDENTIAL)));
  if (!row?.hash) {
    // Mismo costo que una verificación real: el tiempo no dice si hay contraseña.
    await hashPassword(password);
    return false;
  }
  return verifyPassword({ hash: row.hash, password });
}

/** Marca la sesión como recién reautenticada (acciones críticas durante unos minutos). */
export async function markReauthenticated(db: Db, input: { userId: string; sessionId: string; now?: Date }): Promise<void> {
  const updated = await db
    .update(session)
    .set({ reauthenticatedAt: input.now ?? new Date() })
    .where(and(eq(session.id, input.sessionId), eq(session.userId, input.userId)))
    .returning({ id: session.id });
  if (updated.length === 0) throw new StaffError("Tu sesión terminó. Vuelve a ingresar.");
}

function assertNewPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) throw new StaffError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  if (password.length > 128) throw new StaffError("La contraseña es muy larga");
}

/**
 * La persona cambia su propia contraseña (también la temporal del primer ingreso). Cierra sus
 * otras sesiones y quita la marca de contraseña temporal. Devuelve false si la actual no coincide.
 */
export async function changeOwnPassword(
  db: Db,
  input: { userId: string; sessionId: string; currentPassword: string; newPassword: string },
): Promise<boolean> {
  assertNewPassword(input.newPassword);
  if (input.newPassword === input.currentPassword) throw new StaffError("La contraseña nueva debe ser distinta de la actual");
  if (!(await verifyUserPassword(db, input.userId, input.currentPassword))) return false;
  const hash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(account)
      .set({ password: hash, updatedAt: new Date() })
      .where(and(eq(account.userId, input.userId), eq(account.providerId, CREDENTIAL)));
    await tx.update(user).set({ mustChangePassword: false, updatedAt: new Date() }).where(eq(user.id, input.userId));
    await tx.delete(session).where(and(eq(session.userId, input.userId), ne(session.id, input.sessionId)));
  });
  return true;
}

/** Usuario (con acceso a la app) de una persona de la sede; error si no existe o no tiene acceso. */
async function memberUserId(db: Db, input: { locationId: bigint; staffId: bigint }): Promise<string> {
  const [row] = await db
    .select({ userId: staffMembers.userId })
    .from(staffMembers)
    .where(and(eq(staffMembers.locationId, input.locationId), eq(staffMembers.id, input.staffId)));
  if (!row) throw new StaffError("La persona no existe en esta sede");
  if (!row.userId) throw new StaffError("Esta persona no tiene acceso a la app");
  return row.userId;
}

/**
 * El dueño le pone una contraseña temporal nueva a alguien del personal (la olvidó o se filtró):
 * queda marcada para cambiarla al ingresar y se cierran TODAS sus sesiones.
 */
export async function resetStaffPassword(db: Db, input: { locationId: bigint; staffId: bigint; password: string }): Promise<void> {
  assertNewPassword(input.password);
  const userId = await memberUserId(db, input);
  const hash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(account)
      .set({ password: hash, updatedAt: new Date() })
      .where(and(eq(account.userId, userId), eq(account.providerId, CREDENTIAL)))
      .returning({ id: account.id });
    if (updated.length === 0) throw new StaffError("Esta persona no tiene contraseña en la app");
    await tx.update(user).set({ mustChangePassword: true, updatedAt: new Date() }).where(eq(user.id, userId));
    await tx.delete(session).where(eq(session.userId, userId));
  });
}

/** Cierra todas las sesiones de una persona de la sede (p. ej. perdió el celular). Devuelve cuántas. */
export async function revokeStaffSessions(db: Db, input: { locationId: bigint; staffId: bigint }): Promise<number> {
  const userId = await memberUserId(db, input);
  const rows = await db.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
  return rows.length;
}
