import { addDays, isDateString, isoWeekday } from "../booking/clock";

// Periodo de los informes (docs/sprint-5-comisiones-informes.md §6.1): días contables (fecha local de
// la sede), ambos incluidos, máximo 366 días. Los atajos se calculan con el "hoy" de la sede, nunca
// con el del navegador.

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

export const MAX_REPORT_DAYS = 366;

export type PeriodPreset = "today" | "yesterday" | "this_week" | "this_month" | "last_month" | "this_year";
export const PERIOD_PRESETS: readonly PeriodPreset[] = ["today", "yesterday", "this_week", "this_month", "last_month", "this_year"];
export const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  today: "Hoy",
  yesterday: "Ayer",
  this_week: "Esta semana",
  this_month: "Este mes",
  last_month: "Mes anterior",
  this_year: "Este año",
};

export interface ReportPeriod {
  readonly from: string;
  readonly to: string;
}

/** Días entre dos fechas de calendario (to − from), sin depender de la zona. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Valida el periodo: fechas reales, from ≤ to y a lo sumo 366 días (ambos incluidos). */
export function reportPeriod(from: string, to: string): ReportPeriod {
  if (!isDateString(from) || !isDateString(to)) throw new ReportError("Fecha inválida en el periodo");
  if (from > to) throw new ReportError("La fecha inicial del periodo es posterior a la final");
  if (daysBetween(from, to) + 1 > MAX_REPORT_DAYS) throw new ReportError(`El periodo no puede pasar de ${MAX_REPORT_DAYS} días`);
  return { from, to };
}

const firstOfMonth = (day: string) => `${day.slice(0, 7)}-01`;
const lastOfMonth = (day: string) => addDays(firstOfMonth(addDays(firstOfMonth(day), 32)), -1);

export function presetPeriod(preset: PeriodPreset, today: string): ReportPeriod {
  if (!isDateString(today)) throw new ReportError("Fecha inválida");
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "this_week": {
      const monday = addDays(today, 1 - isoWeekday(today));
      return { from: monday, to: addDays(monday, 6) };
    }
    case "this_month":
      return { from: firstOfMonth(today), to: lastOfMonth(today) };
    case "last_month": {
      const last = addDays(firstOfMonth(today), -1);
      return { from: firstOfMonth(last), to: last };
    }
    case "this_year":
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
  }
}

/** El mismo día de la semana anterior. */
export function sameDayLastWeek(day: string): string {
  return addDays(day, -7);
}

/**
 * El mismo tramo del mes anterior: del 1 al mismo día del mes, recortado si el mes anterior es más
 * corto (31 de marzo → 1 al 28 de febrero).
 */
export function sameSpanPreviousMonth(today: string): ReportPeriod {
  if (!isDateString(today)) throw new ReportError("Fecha inválida");
  const prevLast = addDays(firstOfMonth(today), -1);
  const day = today.slice(8, 10);
  const candidate = `${prevLast.slice(0, 7)}-${day}`;
  return { from: firstOfMonth(prevLast), to: candidate <= prevLast && isDateString(candidate) ? candidate : prevLast };
}

/** "2026-11-01 a 2026-11-15", o la fecha sola si es un día. */
export function periodLabel(period: ReportPeriod): string {
  return period.from === period.to ? period.from : `${period.from} a ${period.to}`;
}
