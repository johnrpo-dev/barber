import { randomInt } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { hashPassword, symmetricEncrypt, verifyPassword } from "better-auth/crypto";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { type AuditEventInput, recordAudit } from "./audit";
import { account, session, staffMembers, twoFactor, user } from "./schema";
import { revokeTrustedDevices, StaffError } from "./staff";
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
 * otras sesiones, revoca los "dispositivos de confianza" y quita la marca de contraseña temporal.
 * Devuelve false si la actual no coincide.
 */
export async function changeOwnPassword(
  db: Db,
  input: { userId: string; sessionId: string; currentPassword: string; newPassword: string; audit?: AuditEventInput },
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
    await revokeTrustedDevices(tx as unknown as Db, input.userId);
    // En la misma transacción (L11): no hay cambio de contraseña sin su evento, ni evento sin cambio.
    if (input.audit) await recordAudit(tx as unknown as Db, input.audit);
  });
  return true;
}

/**
 * Desactiva la verificación en dos pasos propia y lo deja en la bitácora en UNA transacción (L11).
 * Hace lo mismo que /two-factor/disable de better-auth (marca del usuario, fila del TOTP y
 * "dispositivos de confianza"), pero sin confirmar el cambio aparte del evento. El llamador ya
 * verificó contraseña y código. La sesión actual sigue: better-auth no guarda el estado en la cookie.
 */
export async function disableOwnTwoFactor(db: Db, input: { userId: string; audit: AuditEventInput }): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(user)
      .set({ twoFactorEnabled: false, updatedAt: new Date() })
      .where(and(eq(user.id, input.userId), eq(user.twoFactorEnabled, true)))
      .returning({ id: user.id });
    if (!row) throw new StaffError("No tienes la verificación en dos pasos activa.");
    await tx.delete(twoFactor).where(eq(twoFactor.userId, input.userId));
    await revokeTrustedDevices(tx as unknown as Db, input.userId);
    await recordAudit(tx as unknown as Db, input.audit);
  });
}

/** Mismo alfabeto, largo y forma que los de better-auth ("abcde-12345"), con un generador criptográfico. */
const BACKUP_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const BACKUP_CODE_COUNT = 10;

function newBackupCode(): string {
  let raw = "";
  for (let i = 0; i < 10; i++) raw += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * Códigos de respaldo nuevos (los anteriores dejan de servir) y su evento, en UNA transacción
 * (L11). Se guardan como los guarda better-auth con storeBackupCodes "encrypted": el JSON de la
 * lista cifrado con el secreto de la app; así /two-factor/verify-backup-code los sigue aceptando
 * (test en src/lib/auth.test.ts). Devuelve los códigos en claro para mostrarlos una sola vez.
 */
export async function replaceBackupCodes(db: Db, input: { userId: string; secret: string; audit: AuditEventInput }): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, newBackupCode);
  const encrypted = await symmetricEncrypt({ key: input.secret, data: JSON.stringify(codes) });
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(twoFactor)
      .set({ backupCodes: encrypted })
      .where(and(eq(twoFactor.userId, input.userId), eq(twoFactor.verified, true)))
      .returning({ id: twoFactor.id });
    if (!row) throw new StaffError("No tienes la verificación en dos pasos activa.");
    await recordAudit(tx as unknown as Db, input.audit);
  });
  return codes;
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
    await revokeTrustedDevices(tx as unknown as Db, userId);
  });
}

/**
 * Cierra todas las sesiones de una persona de la sede (p. ej. perdió el celular) y olvida sus
 * dispositivos de confianza. Devuelve cuántas sesiones cerró.
 */
export async function revokeStaffSessions(db: Db, input: { locationId: bigint; staffId: bigint }): Promise<number> {
  const userId = await memberUserId(db, input);
  return db.transaction(async (tx) => {
    const rows = await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
    await revokeTrustedDevices(tx as unknown as Db, userId);
    return rows.length;
  });
}
