import type { Money } from "../money";
import type { ScheduleBlock } from "../staff/schedule";
import type { BusyInterval } from "./availability";
import { floorToStep, isoWeekday, localMinuteOf, MINUTE_MS } from "./clock";
import { businessDate } from "../ledger/business-date";
import { type Interval, nextFreeStart, overlapsAny } from "./interval";

// Reglas de una cita individual: qué rango ocupa, si cabe en el turno y cómo se arma un walk-in.

/** Copia del servicio al agendar: el precio cotizado no cambia si después se edita el catálogo. */
export interface ServiceSnapshot {
  readonly serviceId: bigint;
  readonly name: string;
  readonly durationMin: number;
  readonly bufferMin: number;
  readonly price: Money;
}

export class BookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingError";
  }
}

/** Lo que ocupa la silla: servicio + limpieza. Es el rango del EXCLUDE en Postgres. */
export function occupiedRange(start: Date, durationMin: number, bufferMin: number): { start: Date; end: Date } {
  return { start, end: new Date(start.getTime() + (durationMin + bufferMin) * MINUTE_MS) };
}

/** El servicio (sin la limpieza) cabe completo dentro de un bloque del turno ese día. */
export function fitsSchedule(start: Date, durationMin: number, blocks: readonly ScheduleBlock[], timeZone: string): boolean {
  const weekday = isoWeekday(businessDate(start, timeZone));
  const startMin = localMinuteOf(start, timeZone);
  const endMin = startMin + durationMin;
  return blocks.some((b) => b.weekday === weekday && b.startMin <= startMin && endMin <= b.endMin);
}

function busyFor(staffId: bigint, busy: readonly BusyInterval[]): Interval[] {
  return busy
    .filter((b) => b.staffId === null || b.staffId === staffId)
    .map((b) => ({ start: b.start.getTime(), end: b.end.getTime() }));
}

/** Choca con otra cita o una ausencia de ese barbero (o un cierre de la sede). */
export function overlapsBusy(staffId: bigint, range: { start: Date; end: Date }, busy: readonly BusyInterval[]): boolean {
  return overlapsAny({ start: range.start.getTime(), end: range.end.getTime() }, busyFor(staffId, busy));
}

export interface WalkInPlan {
  readonly start: Date;
  /** Barberos que pueden atender ya, en el orden recibido. */
  readonly freeNow: bigint[];
  /** Para los ocupados, cuándo se liberan para este servicio. */
  readonly nextFree: { staffId: bigint; at: Date }[];
}

/**
 * Walk-in: empieza ahora (redondeado a 5 min). Nunca se pone encima de una cita reservada:
 * si el barbero está ocupado, se informa cuándo queda libre.
 */
export function planWalkIn(input: {
  now: Date;
  durationMin: number;
  bufferMin: number;
  staffIds: readonly bigint[];
  busy: readonly BusyInterval[];
}): WalkInPlan {
  const start = floorToStep(input.now, 5);
  const length = (input.durationMin + input.bufferMin) * MINUTE_MS;
  const freeNow: bigint[] = [];
  const nextFree: { staffId: bigint; at: Date }[] = [];
  for (const staffId of input.staffIds) {
    const at = nextFreeStart(start.getTime(), length, busyFor(staffId, input.busy));
    if (at === start.getTime()) freeNow.push(staffId);
    else nextFree.push({ staffId, at: new Date(at) });
  }
  nextFree.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { start, freeNow, nextFree };
}

/** Cancelación tardía: dentro de las horas de cancelación gratuita (se registra, no se cobra todavía). */
export function isLateCancellation(now: Date, start: Date, freeCancelHours: number): boolean {
  return start.getTime() - now.getTime() < freeCancelHours * 60 * MINUTE_MS;
}
