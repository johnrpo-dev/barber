import { MINUTE_MS } from "../booking/clock";

// Cuándo toca cada recordatorio y la clave que impide mandarlo dos veces
// (notifications: UNIQUE(location_id, dedupe_key)). El scan corre cada minuto, así que las
// ventanas son anchas: si el worker estuvo caído, el recordatorio sale tarde pero sale, y
// nunca a menos de 30 minutos de la cita.

export type ReminderKind = "reminder_24h" | "reminder_2h";
export type DedupeKind = "confirm" | "rem24" | "rem2" | "cancel" | "resched";

const HOUR_MS = 60 * MINUTE_MS;

/** 24 h: falta ≤ 24 h y > 3 h. 2 h: falta ≤ 2 h y > 30 min. Las ventanas no se cruzan. */
export function dueReminders(now: Date, start: Date): ReminderKind[] {
  const left = start.getTime() - now.getTime();
  if (left > 3 * HOUR_MS && left <= 24 * HOUR_MS) return ["reminder_24h"];
  if (left > 30 * MINUTE_MS && left <= 2 * HOUR_MS) return ["reminder_2h"];
  return [];
}

export const REMINDER_DEDUPE: Record<ReminderKind, "rem24" | "rem2"> = { reminder_24h: "rem24", reminder_2h: "rem2" };

const NEEDS_START: readonly DedupeKind[] = ["rem24", "rem2", "resched"];

/**
 * confirm:{publicId}, cancel:{publicId}; rem24/rem2/resched llevan además el inicio en ISO,
 * así que al reprogramar nacen claves nuevas y las viejas quedan para suprimir.
 */
export function dedupeKey(kind: DedupeKind, publicId: string, start?: Date): string {
  if (!NEEDS_START.includes(kind)) return `${kind}:${publicId}`;
  if (!start) throw new Error(`La clave ${kind} necesita la hora de inicio`);
  return `${kind}:${publicId}:${start.toISOString()}`;
}
