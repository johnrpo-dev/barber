import { createHash, createHmac } from "node:crypto";
import { and, eq, inArray, isNotNull, like, lt, or, sql } from "drizzle-orm";
import {
  failuresExpired,
  LOCKOUT_POLICY,
  type LockoutPolicy,
  lockDurationMs,
  lockedMessage,
} from "@/domain/security/lockout";
import { loginThrottles, twoFactor, user } from "./schema";
import type { Db } from "./types";

// Bloqueo por cuenta tras intentos fallidos, guardado en Postgres (sobrevive a reinicios y vale
// para todos los procesos).
//
// El intento se RESERVA antes de verificar la credencial: dentro de una transacción con
// pg_advisory_xact_lock por sujeto se revisa el bloqueo y se suma 1 al contador. Así N peticiones
// en paralelo no pueden pasar todas la revisión: a lo sumo `threshold` llegan a verificar.
// Un acierto borra el contador (o lo descuenta, en el límite global por correo); un intento que no
// llegó a verificar nada (datos mal escritos) se devuelve con releaseAttempt.

export class AccountLockedError extends Error {
  constructor(readonly lockedUntil: Date, now: Date) {
    super(lockedMessage(lockedUntil, now));
    this.name = "AccountLockedError";
  }
}

/** Qué se está contando (solo para el registro; nunca va el sujeto ni el correo). */
export type ThrottleKind = "login" | "login-ip" | "reauth" | "password" | "totp-login";

/** Sujetos por usuario: reautenticación, contraseña propia y segundo factor del ingreso. */
export type UserThrottleKind = "reauth" | "password" | "totp-login";

export interface ThrottleTarget {
  subject: string;
  kind: ThrottleKind;
  policy?: LockoutPolicy;
}

/** Intento reservado: se cierra con clearFailures/releaseAttempt según cómo terminó. */
export interface Reservation {
  readonly targets: readonly ThrottleTarget[];
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const hmacHex = (secret: string, text: string) => createHmac("sha256", secret).update(text).digest("hex");

/**
 * Límite global por correo: HMAC del correo escrito. Nunca se guarda el correo en claro,
 * exista o no la cuenta.
 */
export function throttleSubject(secret: string, kind: "login", email: string): string {
  return hmacHex(secret, `villa:throttle:${kind}:${normalizeEmail(email)}`);
}

/** Primera mitad de los sujetos (correo, IP): permite desbloquear un correo sin conocer las IP. */
function loginIpPrefix(secret: string, email: string): string {
  return hmacHex(secret, `villa:throttle:login-ip-email:${normalizeEmail(email)}`).slice(0, 32);
}

/**
 * Bloqueo duro por (correo, cubeta de IP): 32 hex del HMAC del correo + 32 hex del HMAC del par.
 * Ni el correo ni la IP quedan en claro; la cubeta de IPv6 es su /64 (better-auth getIP).
 */
export function loginIpThrottleSubject(secret: string, email: string, ipBucket: string): string {
  const pair = hmacHex(secret, `villa:throttle:login-ip:${normalizeEmail(email)}|${ipBucket}`).slice(0, 32);
  return `${loginIpPrefix(secret, email)}${pair}`;
}

/**
 * Sujeto por usuario (reautenticación, cambio de su contraseña, contraseña en /two-factor/*,
 * código del segundo paso del ingreso): el id del usuario es aleatorio y no es un dato personal,
 * basta su SHA-256.
 */
export function userThrottleSubject(kind: UserThrottleKind, userId: string): string {
  return createHash("sha256").update(`villa:throttle:${kind}:${userId}`).digest("hex");
}

/** Hasta cuándo está bloqueado el sujeto, o null si puede intentar. Solo para consultar. */
export async function lockStatus(db: Db, subject: string, now: Date = new Date()): Promise<Date | null> {
  const [row] = await db.select({ lockedUntil: loginThrottles.lockedUntil }).from(loginThrottles).where(eq(loginThrottles.subject, subject));
  return row?.lockedUntil && row.lockedUntil > now ? row.lockedUntil : null;
}

/** Serializa por sujeto, en orden fijo para que dos reservas con los mismos sujetos no se crucen. */
async function lockSubjects(tx: Db, subjects: readonly string[]): Promise<void> {
  for (const s of [...new Set(subjects)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${s}, 0))`);
  }
}

/**
 * Reserva un intento ANTES de verificar la credencial: si algún sujeto está bloqueado lanza
 * AccountLockedError sin contar nada; si no, suma 1 a cada uno y, si alguno llega al umbral, lo
 * bloquea ya (el intento en curso sí se verifica; los siguientes esperan).
 */
export async function reserveAttempt(db: Db, targets: readonly ThrottleTarget[], now: Date = new Date()): Promise<Reservation> {
  if (targets.length === 0) return { targets };
  const fired: { kind: ThrottleKind; failures: number; minutes: number }[] = [];
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await lockSubjects(t, targets.map((x) => x.subject));
    const rows = await t
      .select()
      .from(loginThrottles)
      .where(inArray(loginThrottles.subject, targets.map((x) => x.subject)));
    const bySubject = new Map(rows.map((r) => [r.subject, r]));
    const locks = rows.map((r) => r.lockedUntil).filter((d): d is Date => d !== null && d > now);
    if (locks.length > 0) throw new AccountLockedError(new Date(Math.max(...locks.map((d) => d.getTime()))), now);

    for (const target of targets) {
      const policy = target.policy ?? LOCKOUT_POLICY;
      const row = bySubject.get(target.subject);
      const failures = !row || failuresExpired(row.lastFailureAt, now, policy) ? 1 : row.failures + 1;
      const ms = lockDurationMs(failures, policy);
      // Ningún bloqueo de este sujeto está vigente (se revisó arriba): no se acorta nada.
      const lockedUntil = ms > 0 ? new Date(now.getTime() + ms) : null;
      await t
        .insert(loginThrottles)
        .values({ subject: target.subject, failures, lastFailureAt: now, lockedUntil })
        .onConflictDoUpdate({ target: loginThrottles.subject, set: { failures, lastFailureAt: now, lockedUntil } });
      if (ms > 0) fired.push({ kind: target.kind, failures, minutes: Math.ceil(ms / 60_000) });
    }
  });
  // Sin datos personales: ni correo, ni IP, ni sujeto. El aviso al dueño llega en el sprint 5.
  for (const f of fired) console.warn("[seguridad] bloqueo por intentos fallidos", f);
  return { targets };
}

/**
 * El intento reservado no llegó a verificar una credencial (p. ej. datos mal escritos): se
 * devuelve. Si el contador baja del umbral, se quita el bloqueo que esta reserva había puesto.
 */
export async function releaseAttempt(db: Db, reservation: Reservation): Promise<void> {
  if (reservation.targets.length === 0) return;
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await lockSubjects(t, reservation.targets.map((x) => x.subject));
    for (const target of reservation.targets) {
      const policy = target.policy ?? LOCKOUT_POLICY;
      await t.delete(loginThrottles).where(and(eq(loginThrottles.subject, target.subject), sql`${loginThrottles.failures} <= 1`));
      await t
        .update(loginThrottles)
        .set({
          failures: sql`${loginThrottles.failures} - 1`,
          lockedUntil: sql`case when ${loginThrottles.failures} - 1 < ${policy.threshold} then null else ${loginThrottles.lockedUntil} end`,
        })
        .where(eq(loginThrottles.subject, target.subject));
    }
  });
}

/** Un acierto borra el historial de fallos del sujeto. */
export async function clearFailures(db: Db, subject: string): Promise<void> {
  await db.delete(loginThrottles).where(eq(loginThrottles.subject, subject));
}

/** Un acierto: borra el contador de cada sujeto reservado. */
export async function clearReservation(db: Db, reservation: Reservation): Promise<void> {
  const subjects = reservation.targets.map((t) => t.subject);
  if (subjects.length > 0) await db.delete(loginThrottles).where(inArray(loginThrottles.subject, subjects));
}

/**
 * `npm run staff:unlock`: borra los contadores y bloqueos de un correo (todas sus IP, el límite
 * global y, si la cuenta existe, la reautenticación, la contraseña y el bloqueo del TOTP).
 * Devuelve cuántas filas tocó.
 */
export async function unlockAccount(db: Db, input: { secret: string; email: string }): Promise<number> {
  const email = normalizeEmail(input.email);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [u] = await t.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`);
    const subjects = [throttleSubject(input.secret, "login", email)];
    if (u) subjects.push(...(["reauth", "password", "totp-login"] as const).map((kind) => userThrottleSubject(kind, u.id)));
    const deleted = await t
      .delete(loginThrottles)
      .where(or(inArray(loginThrottles.subject, subjects), like(loginThrottles.subject, `${loginIpPrefix(input.secret, email)}%`)))
      .returning({ subject: loginThrottles.subject });
    let totp = 0;
    if (u) {
      const reset = await t
        .update(twoFactor)
        .set({ failedVerificationCount: 0, lockedUntil: null })
        .where(and(eq(twoFactor.userId, u.id), or(isNotNull(twoFactor.lockedUntil), sql`${twoFactor.failedVerificationCount} > 0`)))
        .returning({ id: twoFactor.id });
      totp = reset.length;
    }
    return deleted.length + totp;
  });
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
