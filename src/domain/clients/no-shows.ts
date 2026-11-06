// Faltas ("No vino") y la reserva en línea (decisión del dueño, sprint 7): con `limit` faltas
// (2 por defecto, en Ajustes) el cliente ya no reserva en línea; recepción o el dueño lo
// desbloquean y desde ese momento las faltas viejas dejan de contar.
//
// - Cuenta la hora en que se marcó la falta (status_changed_at de la cita en no_show). Si después
//   la cita vuelve a "Llegó", deja de ser falta y no cuenta.
// - Llegar tarde o cancelar a última hora no es falta (decisión del dueño): solo cuenta no_show.
// - Solo cuentan las de los últimos NO_SHOW_WINDOW_DAYS días: dos faltas de hace años no
//   deberían cerrarle la reserva a un cliente que ya volvió a cumplir.
// - El personal puede agendarle igual (solo ve el aviso); el bloqueo es para la reserva en línea.

import { MINUTE_MS } from "../booking/clock";

export const NO_SHOW_WINDOW_DAYS = 180;

export interface NoShowStanding {
  /** Faltas que cuentan hoy. */
  readonly count: number;
  readonly limit: number;
  readonly suspended: boolean;
}

/** Desde cuándo cuentan las faltas: lo más reciente entre el desbloqueo y el inicio de la ventana. */
export function noShowsCountFrom(clearedAt: Date | null, now: Date): Date {
  const windowStart = now.getTime() - NO_SHOW_WINDOW_DAYS * 24 * 60 * MINUTE_MS;
  return new Date(Math.max(windowStart, clearedAt?.getTime() ?? Number.NEGATIVE_INFINITY));
}

export function noShowStanding(input: { markedAt: readonly Date[]; clearedAt: Date | null; now: Date; limit: number }): NoShowStanding {
  const from = noShowsCountFrom(input.clearedAt, input.now).getTime();
  const count = input.markedAt.filter((t) => t.getTime() > from && t.getTime() <= input.now.getTime()).length;
  return { count, limit: input.limit, suspended: count >= input.limit };
}

/** El aviso para el personal (panel): cuántas faltas lleva y si ya no puede reservar en línea. */
export function noShowNotice(s: NoShowStanding): string | null {
  if (s.count === 0) return null;
  const faltas = s.count === 1 ? "1 falta" : `${s.count} faltas`;
  return s.suspended ? `Reserva en línea suspendida: ${faltas}` : `${faltas} (con ${s.limit} se suspende la reserva en línea)`;
}
