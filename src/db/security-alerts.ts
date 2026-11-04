import { and, asc, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { type LockAlertRow, type LockKind, lockAlertMessage } from "@/domain/security/lock-alert";
import { windowStart } from "@/domain/security/rate-limit";
import { hit } from "./rate-limit";
import { securityAlerts, user } from "./schema";
import type { Db } from "./types";

// Bandeja de avisos de seguridad al dueño (migración 0012). El bloqueo se encola en la MISMA
// transacción que lo dispara (src/db/login-throttle.ts); el worker la entrega con alertSender()
// (correo a ALERT_EMAIL por Resend o, sin correo, el registro del servidor).

/** De quién es el intento, si se sabe. El correo solo se usa para buscar la cuenta; no se guarda. */
export type LockAccount = { userId: string } | { email: string };

/** Como mucho un correo de seguridad cada 15 minutos: un ataque no llena la bandeja del dueño. */
export const ALERT_WINDOW_SEC = 15 * 60;
/** Los avisos ya entregados se borran a los 90 días (el registro del servidor queda). */
export const ALERT_RETENTION_MS = 90 * 86_400_000;

export async function enqueueLockAlert(
  db: Db,
  input: { kind: LockKind; account?: LockAccount; failures: number; lockedUntil: Date; now?: Date },
): Promise<void> {
  let userId: string | null = null;
  if (input.account && "userId" in input.account) userId = input.account.userId;
  else if (input.account?.email) {
    const email = input.account.email.trim().toLowerCase();
    const [u] = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`).limit(1);
    userId = u?.id ?? null;
  }
  // Una sola fila pendiente por (tipo, cuenta o "sin cuenta", ventana): un ataque desde muchas IP
  // suma en occurrences y no llena la tabla. A mano porque Drizzle no acepta una expresión como
  // destino de ON CONFLICT; es la de security_alerts_window_key.
  const window = windowStart(input.now ?? new Date(), ALERT_WINDOW_SEC);
  await db.execute(sql`
    insert into security_alerts (kind, throttle_kind, user_id, failures, locked_until, window_start)
    values ('login_lock', ${input.kind}, ${userId}, ${input.failures}, ${input.lockedUntil.toISOString()}::timestamptz, ${window.toISOString()}::timestamptz)
    on conflict (throttle_kind, coalesce(user_id, ''), window_start) where notified_at is null
    do update set occurrences = security_alerts.occurrences + 1,
                  failures = greatest(security_alerts.failures, excluded.failures),
                  locked_until = greatest(security_alerts.locked_until, excluded.locked_until)`);
}

/**
 * Cada minuto (worker): si hay avisos sin entregar y no se mandó otro en esta ventana de 15
 * minutos, manda UN correo con todos y los marca entregados. Si el envío falla, quedan pendientes
 * para la ventana siguiente. Devuelve cuántos avisos cubrió el correo.
 */
export async function deliverSecurityAlerts(
  db: Db,
  send: (subject: string, text: string, idempotencyKey: string) => Promise<void>,
  opts: { now?: Date; timeZone?: string; limit?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const pending = await db
    .select({
      id: securityAlerts.id,
      throttleKind: securityAlerts.throttleKind,
      failures: securityAlerts.failures,
      lockedUntil: securityAlerts.lockedUntil,
      createdAt: securityAlerts.createdAt,
      occurrences: securityAlerts.occurrences,
      // Una cuenta puede estar en varias sedes: cualquiera de sus nombres sirve para el aviso.
      // (Columnas calificadas a mano: dentro de la subconsulta Drizzle las escribe sin tabla.)
      staffName: sql<string | null>`(select sm.display_name from staff_members sm
        where sm.user_id = "security_alerts"."user_id" order by sm.id limit 1)`,
    })
    .from(securityAlerts)
    .where(isNull(securityAlerts.notifiedAt))
    // Las cuentas conocidas primero: si el tope corta, corta lo de correos ajenos.
    .orderBy(sql`("security_alerts"."user_id" is null)`, asc(securityAlerts.id))
    .limit(opts.limit ?? 200);
  if (pending.length === 0) return 0;
  // El contador de límites sirve de bandera "ya avisé en esta ventana": solo el primer golpe envía.
  const window = windowStart(now, ALERT_WINDOW_SEC);
  if ((await hit(db, "alert:security", window)) !== 1) return 0;
  const rows: LockAlertRow[] = pending.map((p) => ({ ...p, staffName: p.staffName ?? null }));
  const { subject, text } = lockAlertMessage(rows, opts.timeZone ?? "America/Bogota");
  await send(subject, text, `alert:security:${pending.at(-1)!.id}`);
  await db
    .update(securityAlerts)
    .set({ notifiedAt: now })
    .where(inArray(securityAlerts.id, pending.map((p) => p.id)));
  return pending.length;
}

/** Mantenimiento diario: borra los avisos ya entregados hace más de 90 días. */
export async function pruneSecurityAlerts(db: Db, now: Date): Promise<number> {
  const rows = await db
    .delete(securityAlerts)
    .where(and(isNotNull(securityAlerts.notifiedAt), lt(securityAlerts.notifiedAt, new Date(now.getTime() - ALERT_RETENTION_MS))))
    .returning({ id: securityAlerts.id });
  return rows.length;
}

/** Para pruebas y para el panel: los avisos pendientes. */
export async function pendingSecurityAlerts(db: Db): Promise<{ id: bigint; throttleKind: LockKind; userId: string | null }[]> {
  return db
    .select({ id: securityAlerts.id, throttleKind: securityAlerts.throttleKind, userId: securityAlerts.userId })
    .from(securityAlerts)
    .where(isNull(securityAlerts.notifiedAt))
    .orderBy(asc(securityAlerts.id));
}
