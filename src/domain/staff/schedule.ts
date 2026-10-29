// Horario semanal de un barbero, en hora local de la sede.
// Un día puede tener varios bloques (p. ej. 9:00–13:00 y 14:00–19:00 con almuerzo en medio).

/** ISO 8601: 1 = lunes … 7 = domingo. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  1: "Lunes",
  2: "Martes",
  3: "Miércoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sábado",
  7: "Domingo",
};

export interface ScheduleBlock {
  readonly weekday: Weekday;
  /** Minutos desde la medianoche local: 9:30 = 570. */
  readonly startMin: number;
  readonly endMin: number;
}

export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduleError";
  }
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

/** "09:30" → 570. Acepta "24:00" como fin del día. */
export function parseTime(value: string): number {
  if (!TIME.test(value)) throw new InvalidScheduleError(`Hora inválida: ${value} (usa HH:MM)`);
  const [h, m] = value.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Valida y devuelve los bloques ordenados por día y hora. Bloques que se tocan (13:00–13:00) no se solapan. */
export function assertValidWeeklySchedule(blocks: readonly ScheduleBlock[]): ScheduleBlock[] {
  for (const b of blocks) {
    if (!Number.isInteger(b.weekday) || b.weekday < 1 || b.weekday > 7) {
      throw new InvalidScheduleError(`Día inválido: ${b.weekday}`);
    }
    if (!Number.isInteger(b.startMin) || !Number.isInteger(b.endMin) || b.startMin % 5 !== 0 || b.endMin % 5 !== 0) {
      throw new InvalidScheduleError("Las horas deben ir en múltiplos de 5 minutos");
    }
    if (b.startMin < 0 || b.endMin > 24 * 60 || b.startMin >= b.endMin) {
      throw new InvalidScheduleError(
        `${WEEKDAY_LABELS[b.weekday]}: el bloque ${formatTime(b.startMin)}–${formatTime(b.endMin)} no es válido`,
      );
    }
  }
  const sorted = [...blocks].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.weekday === cur.weekday && cur.startMin < prev.endMin) {
      throw new InvalidScheduleError(
        `${WEEKDAY_LABELS[cur.weekday]}: ${formatTime(prev.startMin)}–${formatTime(prev.endMin)} se cruza con ${formatTime(cur.startMin)}–${formatTime(cur.endMin)}`,
      );
    }
  }
  return sorted;
}
