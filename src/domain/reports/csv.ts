import type { Money } from "../money";
import { ReportError, type ReportPeriod } from "./period";

// Exportación CSV (docs/sprint-5-comisiones-informes.md §6.3): UTF-8 con BOM, separador ";", fin de
// línea CRLF, montos en pesos con coma decimal y dos decimales, sin separador de miles. Toda celda
// de texto pasa por csvText, que neutraliza la inyección de fórmulas (=, +, -, @, tab, CR, LF).

export type CsvCell = { text: string } | { money: Money } | { date: string } | { count: bigint };

export const CSV_MAX_ROWS = 50_000;
export const CSV_TOO_MANY_ROWS = "El periodo tiene demasiados movimientos para exportar; exporta por meses.";

export const CSV_REPORTS = ["pnl", "journal", "by_staff", "by_service", "payments", "tips", "expenses", "cash_differences", "settlements", "sales", "cash_sessions"] as const;
export type CsvReport = (typeof CSV_REPORTS)[number];

const CSV_SLUGS: Record<CsvReport, string> = {
  pnl: "estado-de-resultados",
  journal: "libro-diario",
  by_staff: "ventas-por-barbero",
  by_service: "ventas-por-servicio",
  payments: "medios-de-pago",
  tips: "propinas",
  expenses: "gastos",
  cash_differences: "diferencias-de-caja",
  settlements: "liquidaciones",
  sales: "ventas",
  cash_sessions: "aperturas-y-cierres-de-caja",
};

const BOM = "﻿";
const FORMULA_START = /^[=+\-@\t\r\n]/;
/** Lo que una hoja de cálculo puede ignorar antes de leer la fórmula: espacios Unicode, controles e invisibles. */
const INVISIBLE_LEAD = /^[\p{Z}\p{Cc}\p{Cf}]+/u;
const NEEDS_QUOTES = /[;"\r\n]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "-12000,00": pesos con coma decimal y dos decimales, desde bigint (nunca number ni toFixed). */
export function csvMoney(amount: Money): string {
  const negative = amount.minor < 0n;
  const abs = negative ? -amount.minor : amount.minor;
  return `${negative ? "-" : ""}${abs / 100n},${(abs % 100n).toString().padStart(2, "0")}`;
}

/** Neutraliza fórmulas (antepone ') y cita si hace falta (comillas internas duplicadas). */
export function csvText(value: string): string {
  const safe = FORMULA_START.test(value) || FORMULA_START.test(value.replace(INVISIBLE_LEAD, "")) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function cell(c: CsvCell): string {
  if ("text" in c) return csvText(c.text);
  if ("money" in c) return csvMoney(c.money);
  if ("date" in c) {
    // Una fecha es una celda generada por el servidor; si no tiene forma de fecha, va como texto.
    return DATE.test(c.date) ? c.date : csvText(c.date);
  }
  return c.count.toString();
}

/** BOM + filas separadas por CRLF, celdas por ";". El encabezado también pasa por csvText. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  if (rows.length > CSV_MAX_ROWS) throw new ReportError(CSV_TOO_MANY_ROWS);
  const lines = [header.map(csvText).join(";"), ...rows.map((r) => r.map(cell).join(";"))];
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** villa-<informe>-<desde>-a-<hasta>.csv */
export function csvFilename(report: CsvReport, period: ReportPeriod): string {
  return `villa-${CSV_SLUGS[report]}-${period.from}-a-${period.to}.csv`;
}
