import { createHash, createHmac } from "node:crypto";
import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { LOCKOUT_POLICY, type LockoutPolicy, lockDurationMs, lockedMessage } from "@/domain/security/lockout";
import { loginThrottles } from "./schema";
import type { Db } from "./types";

// Bloqueo por cuenta tras intentos fallidos, guardado en Postgres (sobrevive a reinicios y vale
// para todos los procesos). El conteo es atómico: INSERT … ON CONFLICT DO UPDATE … RETURNING.

export class AccountLockedError extends Error {
  constructor(readonly lockedUntil: Date, now: Date) {
    super(lockedMessage(lockedUntil, now));
    this.name = "AccountLockedError";
  }
}

/**
 * Sujeto del contador de ingreso: HMAC del correo escrito. Nunca se guarda el correo en claro,
 * exista o no la cuenta.
 */
export function throttleSubject(secret: string, kind: "login", email: string): string {
  return createHmac("sha256", secret).update(`villa:throttle:${kind}:${email.trim().toLowerCase()}`).digest("hex");
}

/**
 * Sujeto para quien ya inició sesión (reautenticación, cambio de su contraseña): el id del
 * usuario es aleatorio y no es un dato personal, basta su SHA-256.
 */
export function userThrottleSubject(kind: "reauth" | "password", userId: string): string {
  return createHash("sha256").update(`villa:throttle:${kind}:${userId}`).digest("hex");
}

/** Hasta cuándo está bloqueado el sujeto, o null si puede intentar. */
export async function lockStatus(db: Db, subject: string, now: Date = new Date()): Promise<Date | null> {
  const [row] = await db.select({ lockedUntil: loginThrottles.lockedUntil }).from(loginThrottles).where(eq(loginThrottles.subject, subject));
  return row?.lockedUntil && row.lockedUntil > now ? row.lockedUntil : null;
}

/** Lanza AccountLockedError si el sujeto está bloqueado. */
export async function assertNotLocked(db: Db, subject: string, now: Date = new Date()): Promise<void> {
  const until = await lockStatus(db, subject, now);
  if (until) throw new AccountLockedError(until, now);
}

/**
 * Cuenta un fallo y, si llegó al umbral, bloquea con espera creciente. Devuelve el conteo y el
 * bloqueo vigente (si lo hay). Tras el tiempo de calma, el contador empieza de nuevo.
 */
export async function recordFailure(
  db: Db,
  subject: string,
  now: Date = new Date(),
  policy: LockoutPolicy = LOCKOUT_POLICY,
): Promise<{ failures: number; lockedUntil: Date | null }> {
  const resetBefore = new Date(now.getTime() - policy.resetAfterMs);
  const [row] = await db
    .insert(loginThrottles)
    .values({ subject, failures: 1, lastFailureAt: now })
    .onConflictDoUpdate({
      target: loginThrottles.subject,
      set: {
        failures: sql`case when ${loginThrottles.lastFailureAt} <= ${resetBefore.toISOString()}::timestamptz then 1 else ${loginThrottles.failures} + 1 end`,
        lastFailureAt: now,
      },
    })
    .returning({ failures: loginThrottles.failures, lockedUntil: loginThrottles.lockedUntil });
  if (!row) throw new Error("No se pudo contar el intento fallido");
  const ms = lockDurationMs(row.failures, policy);
  if (ms === 0) return { failures: row.failures, lockedUntil: row.lockedUntil && row.lockedUntil > now ? row.lockedUntil : null };
  const until = new Date(now.getTime() + ms);
  // Nunca acorta un bloqueo vigente (dos fallos simultáneos se quedan con el más largo).
  await db
    .update(loginThrottles)
    .set({ lockedUntil: until })
    .where(and(eq(loginThrottles.subject, subject), or(sql`${loginThrottles.lockedUntil} is null`, lt(loginThrottles.lockedUntil, until))));
  return { failures: row.failures, lockedUntil: until };
}

/** Un acierto borra el historial de fallos del sujeto. */
export async function clearFailures(db: Db, subject: string): Promise<void> {
  await db.delete(loginThrottles).where(eq(loginThrottles.subject, subject));
}

/** Mantenimiento diario: borra lo que ya no bloquea ni cuenta (sin fallos en el tiempo de calma). */
export async function pruneLoginThrottles(db: Db, now: Date, policy: LockoutPolicy = LOCKOUT_POLICY): Promise<number> {
  const rows = await db
    .delete(loginThrottles)
    .where(
      and(
        lt(loginThrottles.lastFailureAt, new Date(now.getTime() - policy.resetAfterMs)),
        or(sql`${loginThrottles.lockedUntil} is null`, and(isNotNull(loginThrottles.lockedUntil), lt(loginThrottles.lockedUntil, now))),
      ),
    )
    .returning({ subject: loginThrottles.subject });
  return rows.length;
}
