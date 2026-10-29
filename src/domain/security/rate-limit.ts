// Límites de uso de lo público con ventana fija. El contador vive en Postgres
// (rate_limit_counters: INSERT … ON CONFLICT DO UPDATE SET hits = hits + 1 RETURNING hits);
// aquí solo se decide la cubeta, la ventana y si el golpe número N todavía pasa.
// El sujeto llega ya como HMAC de la IP o del teléfono: nunca en claro.

export type RateAction = "booking_start" | "otp_send" | "otp_verify" | "manage_action";
export type RateScope = "ip" | "contact";

export interface RatePolicy {
  windowSec: number;
  limit: number;
}

const HOUR = 3600;
const DAY = 86_400;

/** La tabla de sprint-3-reserva-publica.md §2. "5 intentos por código" lo cuida otp.ts, no esto. */
export const RATE_POLICIES: Record<RateAction, Partial<Record<RateScope, readonly RatePolicy[]>>> = {
  booking_start: {
    ip: [
      { windowSec: HOUR, limit: 10 },
      { windowSec: DAY, limit: 30 },
    ],
    contact: [{ windowSec: HOUR, limit: 5 }],
  },
  otp_send: {
    ip: [{ windowSec: DAY, limit: 20 }],
    contact: [{ windowSec: DAY, limit: 6 }],
  },
  otp_verify: { ip: [{ windowSec: HOUR, limit: 30 }] },
  manage_action: { ip: [{ windowSec: HOUR, limit: 30 }] },
};

/** Las políticas de una acción para un alcance; vacío si ese alcance no se limita. */
export function policiesFor(action: RateAction, scope: RateScope): readonly RatePolicy[] {
  return RATE_POLICIES[action][scope] ?? [];
}

/** Inicio de la ventana fija que contiene `now`, alineada a la época Unix (en UTC). */
export function windowStart(now: Date, windowSec: number): Date {
  if (!Number.isInteger(windowSec) || windowSec <= 0) throw new RangeError("La ventana debe ser un entero positivo de segundos");
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Clave de la cubeta: "booking_start:ip:3600:<hash>". La ventana va en su propia columna. */
export function rateBucket(action: RateAction, scope: RateScope, subjectHash: string, policy: RatePolicy): string {
  return `${action}:${scope}:${policy.windowSec}:${subjectHash}`;
}

/** `hitsAfterIncrement` es lo que devolvió el RETURNING hits: este golpe ya está contado. */
export function isAllowed(hitsAfterIncrement: number, policy: RatePolicy): boolean {
  return hitsAfterIncrement <= policy.limit;
}
