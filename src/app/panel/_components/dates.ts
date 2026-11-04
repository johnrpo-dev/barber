// Fechas de calendario ("yyyy-MM-dd", días contables de la sede) como texto para la interfaz.
// Se formatean al mediodía UTC con timeZone UTC: la fecha no se corre por la zona del navegador.
// Sirve en el servidor y en el cliente (sin "use client").

const at = (date: string) => new Date(`${date}T12:00:00Z`);
const isDay = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date);

const SHORT = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: "UTC" });
const WITH_YEAR = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

const clean = (s: string) => s.replace(/\./g, "").replace(/\s+de\s+/g, " ");

/** "15 nov" */
export function dayShort(date: string): string {
  return isDay(date) ? clean(SHORT.format(at(date))) : date;
}

/** "15 nov 2026" */
export function dayLabel(date: string): string {
  return isDay(date) ? clean(WITH_YEAR.format(at(date))) : date;
}

/** "Sábado 15 de noviembre" */
export function dayLong(date: string): string {
  if (!isDay(date)) return date;
  const label = LONG.format(at(date));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** De `atLabel` del servidor: "2026-10-28 14:30" pasa a "28 oct 2026, 14:30"; "14:30" (hoy) queda igual. */
export function momentLabel(label: string): string {
  const [date, time] = label.split(" ");
  return date && time && isDay(date) ? `${dayLabel(date)}, ${time}` : label;
}

/** "1 servicio" / "3 servicios" */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
