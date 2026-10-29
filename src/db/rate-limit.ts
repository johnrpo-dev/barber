import { lt, sql } from "drizzle-orm";
import { isAllowed, policiesFor, type RateAction, rateBucket, type RateScope, windowStart } from "@/domain/security/rate-limit";
import { rateLimitCounters } from "./schema";
import type { Db } from "./types";

// Límites de lo público con ventana fija, contados en Postgres. El golpe se cuenta con un solo
// INSERT … ON CONFLICT DO UPDATE … RETURNING: dos peticiones simultáneas nunca leen el mismo
// valor, así que nunca pasan más que el límite. Los sujetos llegan ya como HMAC (hashForBucket).

export const RATE_LIMIT_MESSAGE = "Vas muy rápido. Espera un minuto y vuelve a intentar.";

/**
 * Cuánto esperar, más o menos, según la ventana que saltó: minutos para las de una hora,
 * "mañana" para las diarias. Siempre empieza por "Vas muy rápido" (la interfaz lo reconoce).
 */
export function rateLimitMessage(windowSec: number, waitMs: number): string {
  if (windowSec >= 86_400) return "Vas muy rápido. Intenta de nuevo mañana.";
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return minutes === 1 ? RATE_LIMIT_MESSAGE : `Vas muy rápido. Espera ${minutes} minutos y vuelve a intentar.`;
}

export class RateLimitError extends Error {
  constructor(message = RATE_LIMIT_MESSAGE) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Suma un golpe a la cubeta en esa ventana y devuelve el total (este golpe incluido). */
export async function hit(db: Db, bucket: string, start: Date): Promise<number> {
  const [row] = await db
    .insert(rateLimitCounters)
    .values({ bucket, windowStart: start, hits: 1 })
    .onConflictDoUpdate({
      target: [rateLimitCounters.bucket, rateLimitCounters.windowStart],
      set: { hits: sql`${rateLimitCounters.hits} + 1` },
    })
    .returning({ hits: rateLimitCounters.hits });
  if (!row) throw new Error("No se pudo contar el golpe");
  return row.hits;
}

/**
 * Cuenta el golpe en todas las políticas de la acción (IP, contacto y sede) y lanza
 * RateLimitError si alguna se pasó. El mensaje no dice cuál saltó, solo cuánto esperar
 * (la espera más larga entre las que saltaron).
 */
export async function enforce(
  db: Db,
  action: RateAction,
  subjects: { ip?: string | null; contact?: string | null; location?: string | null },
  now: Date = new Date(),
): Promise<void> {
  let worst: { windowSec: number; waitMs: number } | null = null;
  for (const scope of ["ip", "contact", "location"] as const satisfies readonly RateScope[]) {
    const subject = subjects[scope];
    if (!subject) continue;
    for (const policy of policiesFor(action, scope)) {
      const start = windowStart(now, policy.windowSec);
      const hits = await hit(db, rateBucket(action, scope, subject, policy), start);
      if (isAllowed(hits, policy)) continue;
      const waitMs = start.getTime() + policy.windowSec * 1000 - now.getTime();
      if (!worst || policy.windowSec > worst.windowSec || (policy.windowSec === worst.windowSec && waitMs > worst.waitMs)) {
        worst = { windowSec: policy.windowSec, waitMs };
      }
    }
  }
  if (worst) throw new RateLimitError(rateLimitMessage(worst.windowSec, worst.waitMs));
}

/** Mantenimiento diario: las ventanas más largas son de un día; lo de hace más de 2 días sobra. */
export async function pruneRateLimits(db: Db, now: Date): Promise<number> {
  const rows = await db
    .delete(rateLimitCounters)
    .where(lt(rateLimitCounters.windowStart, new Date(now.getTime() - 2 * 86_400_000)))
    .returning({ bucket: rateLimitCounters.bucket });
  return rows.length;
}
