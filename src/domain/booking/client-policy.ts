import { isLateCancellation } from "./appointment";
import type { AppointmentStatus } from "./status";

// Lo que el CLIENTE puede hacer desde el enlace de gestión (/cita/[token]). status.ts decide
// qué transición es válida; esto agrega las reglas del portal: hasta cuándo y cuántas veces.
// El servidor vuelve a validar dentro de la transacción; esto también pinta los botones.

export const MAX_CLIENT_RESCHEDULES = 2;

export interface ClientAppointmentView {
  status: AppointmentStatus;
  start: Date;
}

export type ClientDecision =
  | { ok: true; late: boolean }
  | { ok: false; reason: "started" | "not_active" | "late_window" | "too_many" | "not_confirmed" };

const CANCELLABLE: readonly AppointmentStatus[] = ["pending", "confirmed"];

/** Cancelar: pendiente o confirmada, hasta la hora de inicio. `late` cobra sentido con freeCancelHours. */
export function clientCanCancel(appt: ClientAppointmentView, now: Date, freeCancelHours: number): ClientDecision {
  if (!CANCELLABLE.includes(appt.status)) return { ok: false, reason: "not_active" };
  if (now.getTime() >= appt.start.getTime()) return { ok: false, reason: "started" };
  return { ok: true, late: isLateCancellation(now, appt.start, freeCancelHours) };
}

/** Reprogramar: solo confirmadas, fuera de la ventana de cancelación gratuita y máximo 2 veces. */
export function clientCanReschedule(
  appt: ClientAppointmentView,
  now: Date,
  freeCancelHours: number,
  reschedulesSoFar: number,
): ClientDecision {
  if (appt.status === "pending") return { ok: false, reason: "not_confirmed" };
  if (appt.status !== "confirmed") return { ok: false, reason: "not_active" };
  if (now.getTime() >= appt.start.getTime()) return { ok: false, reason: "started" };
  if (isLateCancellation(now, appt.start, freeCancelHours)) return { ok: false, reason: "late_window" };
  if (reschedulesSoFar >= MAX_CLIENT_RESCHEDULES) return { ok: false, reason: "too_many" };
  return { ok: true, late: false };
}

/** Tope de citas futuras activas por cliente (locations.max_active_per_client). */
export function activeLimitReached(activeFutureCount: number, maxActive: number): boolean {
  return activeFutureCount >= maxActive;
}
