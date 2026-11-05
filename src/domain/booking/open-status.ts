import type { Weekday } from "@/domain/staff/schedule";
import { formatClock } from "./public-labels";

// "Abierto ahora" del portal: a partir del horario de la sede (la unión de los turnos de los
// barberos) y la hora local de la sede. Rangos en minutos del día, semiabiertos [inicio, fin).

export interface DayHours {
  weekday: Weekday;
  ranges: readonly { start: number; end: number }[];
}

export type OpenStatus =
  | { open: true; closesAt: number }
  | { open: false; opensAt: { daysAhead: number; weekday: Weekday; minute: number } | null };

const nextWeekday = (day: Weekday, ahead: number): Weekday => (((day - 1 + ahead) % 7) + 1) as Weekday;

/** ¿Está abierta ahora? Si sí, a qué hora cierra; si no, cuándo vuelve a abrir (null: nunca abre). */
export function openStatus(week: readonly DayHours[], today: Weekday, minute: number): OpenStatus {
  const rangesOf = (day: Weekday) =>
    [...(week.find((d) => d.weekday === day)?.ranges ?? [])].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);

  const todayRanges = rangesOf(today);
  const current = todayRanges.find((r) => r.start <= minute && minute < r.end);
  if (current) return { open: true, closesAt: current.end };

  const later = todayRanges.find((r) => r.start > minute);
  if (later) return { open: false, opensAt: { daysAhead: 0, weekday: today, minute: later.start } };

  for (let ahead = 1; ahead <= 7; ahead++) {
    const day = nextWeekday(today, ahead);
    const first = rangesOf(day)[0];
    if (first) return { open: false, opensAt: { daysAhead: ahead, weekday: day, minute: first.start } };
  }
  return { open: false, opensAt: null };
}

const WEEKDAY_NAMES: Record<Weekday, string> = {
  1: "el lunes",
  2: "el martes",
  3: "el miércoles",
  4: "el jueves",
  5: "el viernes",
  6: "el sábado",
  7: "el domingo",
};

/** "Abierto ahora · cierra a las 9:00 p. m."; "Cerrado · abre mañana a las 8:00 a. m.". */
export function openStatusLabel(status: OpenStatus): string {
  if (status.open) return `Abierto ahora · cierra a las ${formatClock(status.closesAt)}`;
  if (!status.opensAt) return "Cerrado por ahora";
  const { daysAhead, weekday, minute } = status.opensAt;
  const when = daysAhead === 0 ? "hoy" : daysAhead === 1 ? "mañana" : WEEKDAY_NAMES[weekday];
  return `Cerrado · abre ${when} a las ${formatClock(minute)}`;
}
