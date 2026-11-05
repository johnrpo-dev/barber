import { MINUTE_MS } from "../booking/clock";

// Cuándo toca el recordatorio y la clave que impide mandarlo dos veces
// (notifications: UNIQUE(location_id, dedupe_key)). El scan corre cada minuto, así que la ventana
// es ancha: si el worker estuvo caído, el recordatorio sale tarde pero sale, y nunca a menos de
// 30 minutos de la cita.
//
// Sprint 6 (veredicto del council, aprobado por el dueño): UN solo recordatorio, unas 3 horas
// antes, y solo si la hora se apartó con más de 6 horas de anticipación. Quien reserva para dentro
// de un rato acaba de recibir la confirmación; otro mensaje sería spam. Los de 24 h y 2 h de antes
// quedaron como plantillas viejas: ya no se generan.

export type ReminderKind = "reminder_same_day";
export type DedupeKind = "confirm" | "rem" | "rem24" | "rem2" | "cancel" | "resched";

const HOUR_MS = 60 * MINUTE_MS;
/** El recordatorio sale cuando faltan como mucho 3 h… */
export const REMINDER_LEAD_MS = 3 * HOUR_MS;
/** …y nunca a 30 minutos o menos de la cita. */
export const REMINDER_LATEST_MS = 30 * MINUTE_MS;
/** Solo para horas apartadas con más de esto de anticipación (reserva o último cambio de hora). */
export const REMINDER_MIN_BOOKING_LEAD_MS = 6 * HOUR_MS;

/**
 * ¿Toca el recordatorio? `scheduledAt` es cuándo se fijó la hora actual de la cita: al crearla o,
 * si se reprogramó, en el último cambio.
 */
export function dueReminders(now: Date, start: Date, scheduledAt: Date): ReminderKind[] {
  if (start.getTime() - scheduledAt.getTime() <= REMINDER_MIN_BOOKING_LEAD_MS) return [];
  const left = start.getTime() - now.getTime();
  return left > REMINDER_LATEST_MS && left <= REMINDER_LEAD_MS ? ["reminder_same_day"] : [];
}

export const REMINDER_DEDUPE: Record<ReminderKind, "rem"> = { reminder_same_day: "rem" };

const NEEDS_START: readonly DedupeKind[] = ["rem", "rem24", "rem2", "resched"];

/**
 * confirm:{publicId}, cancel:{publicId}; rem/resched llevan además el inicio en ISO, así que al
 * reprogramar nacen claves nuevas y las viejas quedan para suprimir. (rem24 y rem2: claves viejas.)
 */
export function dedupeKey(kind: DedupeKind, publicId: string, start?: Date): string {
  if (!NEEDS_START.includes(kind)) return `${kind}:${publicId}`;
  if (!start) throw new Error(`La clave ${kind} necesita la hora de inicio`);
  return `${kind}:${publicId}:${start.toISOString()}`;
}
