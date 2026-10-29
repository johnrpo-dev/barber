import { TZDate } from "@date-fns/tz";
import type { Weekday } from "../staff/schedule";

// Conversión entre la hora local de la sede (fecha "yyyy-MM-dd" + minutos desde medianoche)
// y los instantes UTC que se guardan. Siempre con la zona de la sede, nunca la del servidor.

export const MINUTE_MS = 60_000;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): [number, number, number] {
  const m = DATE.exec(date);
  if (!m) throw new Error(`Fecha inválida: ${date} (usa yyyy-MM-dd)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isDateString(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, mo, d] = parts(value);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Instante de `minute` minutos desde la medianoche local de `date`. 1440 = 00:00 del día siguiente. */
export function localMinuteToInstant(date: string, minute: number, timeZone: string): Date {
  const [y, mo, d] = parts(date);
  // El constructor con campos locales resuelve el desfase de esa fecha concreta (y desborda bien 24:00).
  return new Date(new TZDate(y, mo - 1, d, Math.floor(minute / 60), minute % 60, 0, 0, timeZone).getTime());
}

/** Minutos desde la medianoche local del instante. */
export function localMinuteOf(instant: Date, timeZone: string): number {
  const z = new TZDate(instant.getTime(), timeZone);
  return z.getHours() * 60 + z.getMinutes();
}

/** Día ISO de la semana de una fecha de calendario (1 = lunes … 7 = domingo); no depende de la zona. */
export function isoWeekday(date: string): Weekday {
  const [y, mo, d] = parts(date);
  const day = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = parts(date);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/** Fechas de `from` a `to`, ambas incluidas. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Redondea hacia abajo a múltiplos de `stepMin` minutos (las zonas usadas desfasan en horas enteras). */
export function floorToStep(instant: Date, stepMin: number): Date {
  const step = stepMin * MINUTE_MS;
  return new Date(Math.floor(instant.getTime() / step) * step);
}
