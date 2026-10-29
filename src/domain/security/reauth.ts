// Reautenticación para acciones críticas del dueño (crear o ascender dueños, cambiar roles,
// contraseñas del personal y, en el sprint 4, reabrir un día o aprobar reversas).
// Vale si la persona demostró su contraseña o su código de la app hace poco.

/** Ventana en que una prueba de identidad sigue valiendo. */
export const REAUTH_WINDOW_MS = 5 * 60_000;

export const REAUTH_REQUIRED_MESSAGE = "Por seguridad, confirma tu identidad para continuar.";

/** La acción pide confirmar identidad; la interfaz abre el diálogo y reintenta. */
export class ReauthRequiredError extends Error {
  readonly code = "reauth_required" as const;
  constructor(message = REAUTH_REQUIRED_MESSAGE) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

/** Última prueba de identidad: el inicio de sesión o la última reautenticación. */
export function lastAuthAt(sessionCreatedAt: Date | null, reauthenticatedAt: Date | null): Date | null {
  if (!sessionCreatedAt) return reauthenticatedAt;
  if (!reauthenticatedAt) return sessionCreatedAt;
  return reauthenticatedAt > sessionCreatedAt ? reauthenticatedAt : sessionCreatedAt;
}

/** Fresca si ocurrió dentro de la ventana (y no "en el futuro", que sería un reloj mal puesto). */
export function isRecentAuth(at: Date | null, now: Date, windowMs: number = REAUTH_WINDOW_MS): boolean {
  if (!at) return false;
  const age = now.getTime() - at.getTime();
  return age >= -60_000 && age < windowMs;
}
