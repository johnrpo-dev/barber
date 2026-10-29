import { customType } from "drizzle-orm/pg-core";

// tstzrange de Postgres ↔ { start, end } en JS. Siempre semiabierto '[)', igual que el dominio
// (src/domain/booking/interval.ts), para que 10:00–10:30 y 10:30–11:00 no choquen.

export interface TimeRange {
  start: Date;
  end: Date;
}

/** '2026-11-02 14:00:00+00' o '…-05' → Date. Postgres no usa formato ISO estricto. */
function parseTimestamp(raw: string): Date {
  const iso = raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha de rango inválida: ${raw}`);
  return d;
}

export function parseRange(value: string): TimeRange {
  const m = /^\[\s*"?([^",]+)"?\s*,\s*"?([^")]+)"?\s*\)$/.exec(value);
  if (!m) throw new Error(`Rango no soportado (se espera '[inicio,fin)'): ${value}`);
  return { start: parseTimestamp(m[1]!), end: parseTimestamp(m[2]!) };
}

export function formatRange(range: TimeRange): string {
  return `[${range.start.toISOString()},${range.end.toISOString()})`;
}

export const tstzrange = customType<{ data: TimeRange; driverData: string }>({
  dataType: () => "tstzrange",
  toDriver: formatRange,
  fromDriver: parseRange,
});
