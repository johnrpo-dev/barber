import { addDays, isDateString } from "../booking/clock";
import type { Money } from "../money";

// Gastos fijos (docs/sprint-8-gastos-controles.md §5): arriendo, servicios públicos, internet. Una
// plantilla dice cuánto se estima, de dónde sale (caja o banco), qué día del mes vence y cada cuántos
// meses. NADA se asienta solo: el sistema muestra los periodos vencidos o por vencer y alguien confirma
// que se pagó (registrar = el formulario de gasto normal, prellenado) o lo omite con un motivo.
//
// Todo con fechas de calendario "yyyy-MM-dd" del día local de la sede (el día contable): quien llama
// calcula `today` con businessDate(ahora, zona de la sede), que usa @date-fns/tz. Aquí no hay horas ni
// zonas: solo aritmética de meses y días sobre fechas de calendario.

/** Cuántos días antes del vencimiento aparece un periodo como "por vencer". */
export const RECURRING_LEAD_DAYS = 3;
export const RECURRING_PAY_MODES = ["cash", "bank"] as const;
export type RecurringPayMode = (typeof RECURRING_PAY_MODES)[number];

export const MIN_RECURRING_NAME = 3;
export const MAX_RECURRING_NAME = 60;
export const MIN_SKIP_REASON = 3;
export const MAX_SKIP_REASON = 300;
/** El mes de inicio, al crearlo o cambiarlo: a lo sumo 12 meses atrás y 12 adelante del mes actual. */
export const START_MONTH_WINDOW = 12;

export class RecurringExpenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurringExpenseError";
  }
}

/** Lo que decide qué periodos tocan: el resto de la plantilla (nombre, monto) no influye. */
export interface RecurringSchedule {
  /** Primer día del primer mes que se paga ("2026-11-01"). */
  startMonth: string;
  /** Cada cuántos meses (1 a 12). */
  intervalMonths: number;
  /** Día del mes en que vence (1 a 28: existe en todos los meses). */
  dayOfMonth: number;
  /** Una plantilla pausada no muestra nada. */
  active: boolean;
}

export type DueStatus = "upcoming" | "due_today" | "overdue";

export interface DuePeriod {
  /** Primer día del mes del periodo ("2026-11-01"): la clave del periodo. */
  period: string;
  /** Fecha de vencimiento ("2026-11-05"). */
  dueDate: string;
  status: DueStatus;
  /** Días que faltan (upcoming) o de atraso (overdue); 0 si vence hoy. */
  days: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Índice absoluto del mes: año × 12 + (mes − 1). */
export function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) - 1);
}

/** Primer día del mes de ese índice. */
export function monthStart(index: number): string {
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}-01`;
}

/** El periodo (primer día del mes) que contiene la fecha. */
export function periodOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function isMonthStart(date: string): boolean {
  return isDateString(date) && date.endsWith("-01");
}

/** Vencimiento del periodo: su mes, el día de la plantilla. */
export function dueDateOf(schedule: Pick<RecurringSchedule, "dayOfMonth">, period: string): string {
  return `${period.slice(0, 8)}${pad(schedule.dayOfMonth)}`;
}

/** Días entre dos fechas de calendario (b − a). No es dinero: number está bien. */
function daysBetween(a: string, b: string): number {
  const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

function assertSchedule(s: RecurringSchedule): void {
  if (!isMonthStart(s.startMonth)) throw new RecurringExpenseError("El mes de inicio no es válido");
  if (!Number.isInteger(s.intervalMonths) || s.intervalMonths < 1 || s.intervalMonths > 12) {
    throw new RecurringExpenseError("Cada cuántos meses: de 1 a 12");
  }
  if (!Number.isInteger(s.dayOfMonth) || s.dayOfMonth < 1 || s.dayOfMonth > 28) {
    throw new RecurringExpenseError("El día de pago va del 1 al 28");
  }
}

/** ¿Es un periodo de la plantilla? Primer día de mes, desde el inicio y al ritmo del intervalo. */
export function isPeriodOf(schedule: RecurringSchedule, period: string): boolean {
  if (!isMonthStart(period) || period < schedule.startMonth) return false;
  return (monthIndex(period) - monthIndex(schedule.startMonth)) % schedule.intervalMonths === 0;
}

function statusOf(dueDate: string, today: string): Pick<DuePeriod, "status" | "days"> {
  const diff = daysBetween(today, dueDate);
  if (diff > 0) return { status: "upcoming", days: diff };
  if (diff === 0) return { status: "due_today", days: 0 };
  return { status: "overdue", days: -diff };
}

/**
 * Periodos vencidos o por vencer (hasta RECURRING_LEAD_DAYS días antes del vencimiento) que aún no se
 * registraron ni se omitieron, del más viejo al más nuevo. Un periodo vencido sigue apareciendo hasta
 * que alguien lo registra u omite: nada se da por pagado solo.
 */
export function duePeriods(
  schedule: RecurringSchedule,
  input: { today: string; registeredOrSkipped: Iterable<string> },
): DuePeriod[] {
  if (!isDateString(input.today)) throw new RecurringExpenseError("Fecha inválida");
  assertSchedule(schedule);
  if (!schedule.active) return [];
  const done = new Set(input.registeredOrSkipped);
  const horizon = addDays(input.today, RECURRING_LEAD_DAYS);
  const out: DuePeriod[] = [];
  for (let i = monthIndex(schedule.startMonth); ; i += schedule.intervalMonths) {
    const period = monthStart(i);
    const dueDate = dueDateOf(schedule, period);
    if (dueDate > horizon) break;
    if (!done.has(period)) out.push({ period, dueDate, ...statusOf(dueDate, input.today) });
  }
  return out;
}

/** El siguiente vencimiento que todavía no aparece en la lista (para "Próximo: 5 dic"). null si está pausada. */
export function nextDueDate(schedule: RecurringSchedule, today: string): string | null {
  assertSchedule(schedule);
  if (!schedule.active) return null;
  const horizon = addDays(today, RECURRING_LEAD_DAYS);
  for (let i = monthIndex(schedule.startMonth); ; i += schedule.intervalMonths) {
    const dueDate = dueDateOf(schedule, monthStart(i));
    if (dueDate > horizon) return dueDate;
  }
}

const CONTROL = new RegExp("[\u0000-\u001f\u007f\u2028\u2029]");

/**
 * Una línea de texto: colapsa los espacios en blanco (saltos de línea, tabulaciones y separadores de
 * línea incluidos) en uno solo y recorta los extremos. NO quita los demás caracteres de control (p. ej.
 * \x07): quien la usa los rechaza con un error claro (la base también, con `!~ '[[:cntrl:]]'`).
 */
export function cleanLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface RecurringDraft {
  name: string;
  estimatedAmount: Money;
  payMode: RecurringPayMode;
  dayOfMonth: number;
  intervalMonths: number;
  startMonth: string;
  active: boolean;
}

/**
 * Valida una plantilla y devuelve el nombre limpio. `today`: el día local de la sede; el mes de
 * inicio se acota solo si cambia (`previousStartMonth`), para no impedir editar una plantilla vieja.
 */
export function validateRecurringDraft(draft: RecurringDraft, ctx: { today: string; previousStartMonth?: string }): { name: string } {
  const name = cleanLine(draft.name);
  if (name.length < MIN_RECURRING_NAME) throw new RecurringExpenseError("Escribe el nombre del gasto fijo (mínimo 3 caracteres)");
  if (name.length > MAX_RECURRING_NAME) throw new RecurringExpenseError("El nombre es muy largo (máximo 60 caracteres)");
  if (CONTROL.test(draft.name)) throw new RecurringExpenseError("El nombre tiene caracteres no válidos");
  if (draft.estimatedAmount.minor <= 0n) throw new RecurringExpenseError("El monto estimado debe ser mayor que cero");
  if (draft.estimatedAmount.minor % 100n !== 0n) throw new RecurringExpenseError("El monto estimado debe ir en pesos enteros");
  if (draft.estimatedAmount.minor > 10n ** 13n) throw new RecurringExpenseError("El monto estimado es demasiado grande");
  if (!(RECURRING_PAY_MODES as readonly string[]).includes(draft.payMode)) throw new RecurringExpenseError("Elige si se paga de la caja o del banco");
  assertSchedule({ startMonth: draft.startMonth, intervalMonths: draft.intervalMonths, dayOfMonth: draft.dayOfMonth, active: draft.active });
  if (draft.startMonth !== ctx.previousStartMonth) {
    const offset = monthIndex(draft.startMonth) - monthIndex(ctx.today);
    if (Math.abs(offset) > START_MONTH_WINDOW) throw new RecurringExpenseError("El mes de inicio debe estar dentro de los 12 meses anteriores o siguientes");
  }
  return { name };
}

/** Motivo de una omisión: una línea de 3 a 300 caracteres, sin caracteres de control. */
export function cleanSkipReason(reason: string): string {
  const clean = cleanLine(reason);
  // Los saltos de línea ya quedaron como espacios; lo que queda de control (p. ej. \x07) se rechaza.
  if (CONTROL.test(clean)) throw new RecurringExpenseError("El motivo tiene caracteres no válidos");
  if (clean.length < MIN_SKIP_REASON) throw new RecurringExpenseError("Escribe por qué se omite (mínimo 3 caracteres)");
  if (clean.length > MAX_SKIP_REASON) throw new RecurringExpenseError("El motivo es muy largo (máximo 300 caracteres)");
  return clean;
}

/** Clave de idempotencia del gasto que registra un periodo: repetir no duplica el gasto ni el registro. */
export function recurringIdempotencyKey(recurringId: bigint, period: string): string {
  return `${RECURRING_KEY_PREFIX}${recurringId}:${period}`;
}
/** Reservado: un gasto normal no puede usar una clave que empiece así (no puede "ocupar" un periodo). */
export const RECURRING_KEY_PREFIX = "recurring:";

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;

/** "2026-11-01" → "noviembre de 2026". */
export function periodLabel(period: string): string {
  return `${MONTHS[Number(period.slice(5, 7)) - 1]} de ${period.slice(0, 4)}`;
}

/** "Cada mes, el día 5" / "Cada 2 meses, el día 15". */
export function scheduleLabel(s: Pick<RecurringSchedule, "intervalMonths" | "dayOfMonth">): string {
  return `${s.intervalMonths === 1 ? "Cada mes" : `Cada ${s.intervalMonths} meses`}, el día ${s.dayOfMonth}`;
}

/** "Vencido hace 3 días" / "Vence hoy" / "Vence en 2 días". */
export function dueStatusLabel(d: Pick<DuePeriod, "status" | "days">): string {
  if (d.status === "due_today") return "Vence hoy";
  const n = d.days === 1 ? "1 día" : `${d.days} días`;
  return d.status === "overdue" ? `Vencido hace ${n}` : `Vence en ${n}`;
}
