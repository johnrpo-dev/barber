// Bloqueo temporal por cuenta tras intentos fallidos (docs/arquitectura.md, "Seguridad").
// El contador vive en Postgres (login_throttles); aquí solo se decide cuánto dura el bloqueo.
// Se cuenta por correo escrito (exista o no la cuenta), así el bloqueo no revela qué correos existen.

export const LOCKOUT_POLICY = {
  /** Fallos seguidos que se toleran antes de bloquear. */
  threshold: 5,
  /** Primer bloqueo; cada fallo siguiente lo duplica… */
  baseMs: 60_000,
  /** …hasta este tope, para que un atacante no deje al dueño fuera por horas. */
  maxMs: 15 * 60_000,
  /** Sin fallos durante este tiempo, el contador vuelve a empezar. */
  resetAfterMs: 24 * 3_600_000,
} as const;

export type LockoutPolicy = { threshold: number; baseMs: number; maxMs: number; resetAfterMs: number };

/**
 * Límite blando por correo, sumando todas las IP (ataque repartido desde muchas direcciones).
 * Mucho más alto que el duro por (correo, IP), para que un atacante no deje al dueño fuera con
 * pocos intentos; además, un navegador donde el dueño ya ingresó ("dispositivo conocido") no lo
 * sufre. Ver docs/arquitectura.md, "Seguridad".
 */
export const LOGIN_EMAIL_POLICY: LockoutPolicy = { ...LOCKOUT_POLICY, threshold: 50 };

/**
 * Duración del bloqueo después del fallo número `failures` (contado desde el último éxito).
 * Cero por debajo del umbral; desde ahí, base · 2^(fallos − umbral), con tope.
 */
export function lockDurationMs(failures: number, policy: LockoutPolicy = LOCKOUT_POLICY): number {
  if (!Number.isInteger(failures) || failures < 0) throw new RangeError("Los fallos deben ser un entero no negativo");
  if (failures < policy.threshold) return 0;
  const exponent = failures - policy.threshold;
  // 2^exponent crece rápido: se corta antes de pasar del tope para no desbordar.
  let ms = policy.baseMs;
  for (let i = 0; i < exponent && ms < policy.maxMs; i++) ms *= 2;
  return Math.min(ms, policy.maxMs);
}

/** El fallo anterior quedó tan atrás que el contador se reinicia. */
export function failuresExpired(lastFailureAt: Date, now: Date, policy: LockoutPolicy = LOCKOUT_POLICY): boolean {
  return now.getTime() - lastFailureAt.getTime() >= policy.resetAfterMs;
}

/** Minutos que faltan (redondeado hacia arriba, mínimo 1), para el mensaje. */
export function minutesLeft(lockedUntil: Date, now: Date): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000));
}

/** Mensaje genérico: igual para un correo que existe y para uno que no. */
export function lockedMessage(lockedUntil: Date, now: Date): string {
  const m = minutesLeft(lockedUntil, now);
  return `Demasiados intentos. Espera ${m === 1 ? "1 minuto" : `${m} minutos`} y vuelve a intentar.`;
}
