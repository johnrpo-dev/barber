import { businessDate } from "../ledger/business-date";
import type { ScheduleBlock } from "../staff/schedule";
import { fitsSchedule } from "./appointment";
import { floorToStep, isoWeekday, localMinuteOf, localMinuteToInstant, MINUTE_MS } from "./clock";
import { type Interval, nextFreeStart, overlapsAny } from "./interval";
import type { AppointmentStatus } from "./status";

// Turno para el cliente sin cita (decisión del dueño, sprint 7): lo atiende el barbero que lleva más
// tiempo libre, es decir, el que terminó primero su último servicio. No entra quien tenga una cita
// que empieza en menos de `guardMin` minutos (60 por defecto), ni quien no alcance a hacer el
// servicio antes de su próxima cita, su descanso o el fin de su turno.
//
// La fila se calcula siempre desde los datos (nunca se guarda): una cita cancelada, un "No vino" o
// un walk-in que se fue devuelven solos el puesto. Reglas finas (revisión del arquitecto):
// - "Libre desde" = lo más tarde entre el fin de su último servicio atendido hoy, el inicio del
//   bloque del turno en que está (después del almuerzo vuelve a contar desde ahí) y el fin de su
//   última ausencia de hoy. Ayer no cuenta.
// - El fin del servicio es el de la cita: al marcarla terminada se recorta a la hora real (con tope
//   en la programada), más la limpieza.
// - Quien está en la silla pasado de la hora programada sin marcar "Terminar" no se elige solo.
// - Empates: menos servicios atendidos hoy primero; luego una rotación que cambia cada día (por
//   nombre favorecería siempre al mismo).

export interface QueueStaff {
  readonly staffId: bigint;
  /** Hace el servicio pedido (staff_services). */
  readonly offersService: boolean;
  readonly blocks: readonly ScheduleBlock[];
}

export interface QueueAppointment {
  readonly staffId: bigint;
  readonly status: AppointmentStatus;
  /** Rango que ocupa la silla: servicio + limpieza (recortado si ya terminó). */
  readonly start: Date;
  readonly end: Date;
  /** Solo para "pending": cuándo vence la retención. */
  readonly expiresAt: Date | null;
}

export interface QueueTimeOff {
  /** null = cierre de toda la sede. */
  readonly staffId: bigint | null;
  readonly start: Date;
  readonly end: Date;
}

export type ExclusionReason =
  | { readonly code: "not_offered" }
  | { readonly code: "off_shift" }
  | { readonly code: "booking_soon"; readonly at: Date }
  | { readonly code: "overdue_in_chair"; readonly since: Date }
  | { readonly code: "away"; readonly until: Date };

export type QueueEntry =
  | { readonly kind: "free"; readonly staffId: bigint; readonly freeSince: Date; readonly attendedToday: number }
  | { readonly kind: "busy"; readonly staffId: bigint; readonly freeAt: Date; readonly attendedToday: number }
  | { readonly kind: "excluded"; readonly staffId: bigint; readonly reason: ExclusionReason };

export interface WalkInQueueInput {
  readonly now: Date;
  readonly timeZone: string;
  readonly durationMin: number;
  readonly bufferMin: number;
  /** Minutos antes de una cita en que el barbero ya no recibe walk-ins. */
  readonly guardMin: number;
  readonly staff: readonly QueueStaff[];
  readonly appointments: readonly QueueAppointment[];
  readonly timeOff: readonly QueueTimeOff[];
}

/** Ocupan la silla (o la van a ocupar): una retención vencida ya no. */
function occupies(a: QueueAppointment, now: Date): boolean {
  if (a.status === "pending") return a.expiresAt === null || a.expiresAt.getTime() > now.getTime();
  return a.status === "confirmed" || a.status === "arrived" || a.status === "in_chair" || a.status === "completed";
}

/** Reservas que cuentan para la regla de los 60 minutos. */
function isBooking(a: QueueAppointment, now: Date): boolean {
  return (a.status === "pending" || a.status === "confirmed" || a.status === "arrived") && occupies(a, now);
}

/** Servicio ya atendido: terminado, o pasado de su hora sin que nadie lo marcara. */
function attendedBefore(a: QueueAppointment, now: Date): boolean {
  if (a.end.getTime() > now.getTime()) return false;
  return a.status === "completed" || a.status === "confirmed" || a.status === "arrived";
}

/** Rotación del día: estable para una fecha y distinta de un día a otro (FNV-1a de 32 bits). */
export function dailyRotation(date: string, staffId: bigint): number {
  let h = 0x811c9dc5;
  for (const ch of `${date}:${staffId}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Inicio del bloque del turno de hoy que contiene `instant`, o null si está fuera del turno. */
function currentBlockStart(instant: Date, blocks: readonly ScheduleBlock[], timeZone: string): Date | null {
  const day = businessDate(instant, timeZone);
  const weekday = isoWeekday(day);
  const minute = localMinuteOf(instant, timeZone);
  const block = blocks.find((b) => b.weekday === weekday && b.startMin <= minute && minute < b.endMin);
  return block ? localMinuteToInstant(day, block.startMin, timeZone) : null;
}

const order = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * La fila del walk-in: primero los libres (por "libre desde": el que más lleva esperando, primero),
 * después los ocupados (por la hora en que se liberan) y al final los que no pueden, con el motivo.
 * Cada barbero aparece una sola vez.
 */
export function walkInQueue(input: WalkInQueueInput): QueueEntry[] {
  const { now, timeZone } = input;
  const start = floorToStep(now, 5);
  const today = businessDate(now, timeZone);
  const dayStart = localMinuteToInstant(today, 0, timeZone).getTime();
  const length = (input.durationMin + input.bufferMin) * MINUTE_MS;

  const free: Extract<QueueEntry, { kind: "free" }>[] = [];
  const busy: Extract<QueueEntry, { kind: "busy" }>[] = [];
  const excluded: Extract<QueueEntry, { kind: "excluded" }>[] = [];

  for (const s of input.staff) {
    const staffId = s.staffId;
    if (!s.offersService) {
      excluded.push({ kind: "excluded", staffId, reason: { code: "not_offered" } });
      continue;
    }
    const mine = input.appointments.filter((a) => a.staffId === staffId);
    const todays = mine.filter((a) => a.start.getTime() >= dayStart);
    const attendedToday = todays.filter((a) => a.status === "completed").length;
    /** Regla del dueño: una cita que empieza en menos de `guardMin` minutos desde `from`. */
    const bookingSoon = (from: number) =>
      mine
        .filter((a) => isBooking(a, now) && a.start.getTime() >= from && a.start.getTime() < from + input.guardMin * MINUTE_MS)
        .sort((a, b) => a.start.getTime() - b.start.getTime())[0];

    // En la silla pasado de la hora programada: no se elige solo hasta que marque "Terminar".
    const overdue = mine.find((a) => a.status === "in_chair" && a.end.getTime() <= start.getTime());
    if (overdue) {
      excluded.push({ kind: "excluded", staffId, reason: { code: "overdue_in_chair", since: overdue.end } });
      continue;
    }

    const blocking: Interval[] = [
      ...mine.filter((a) => occupies(a, now)).map((a) => ({ start: a.start.getTime(), end: a.end.getTime() })),
      // Un cliente con cita que ya llegó y espera ocupa al barbero aunque su hora haya pasado.
      ...mine
        .filter((a) => a.status === "arrived" && a.start.getTime() <= start.getTime())
        .map((a) => ({ start: a.start.getTime(), end: Math.max(a.end.getTime(), start.getTime() + length) })),
      ...input.timeOff
        .filter((t) => t.staffId === null || t.staffId === staffId)
        .map((t) => ({ start: t.start.getTime(), end: t.end.getTime() })),
    ];

    const nowSlot = { start: start.getTime(), end: start.getTime() + length };
    if (overlapsAny(nowSlot, blocking)) {
      const inService = mine.some((a) => occupies(a, now) && a.start.getTime() <= start.getTime() && start.getTime() < a.end.getTime());
      const away = input.timeOff.find(
        (t) => (t.staffId === null || t.staffId === staffId) && t.start.getTime() <= start.getTime() && start.getTime() < t.end.getTime(),
      );
      if (away && !inService) {
        excluded.push({ kind: "excluded", staffId, reason: { code: "away", until: away.end } });
        continue;
      }
      const freeAt = new Date(nextFreeStart(start.getTime(), length, blocking));
      const soon = bookingSoon(freeAt.getTime());
      if (!fitsSchedule(freeAt, input.durationMin, s.blocks, timeZone)) {
        // Se libera, pero ya no le alcanza el turno para el servicio.
        excluded.push({ kind: "excluded", staffId, reason: { code: "off_shift" } });
      } else if (soon) {
        excluded.push({ kind: "excluded", staffId, reason: { code: "booking_soon", at: soon.start } });
      } else {
        busy.push({ kind: "busy", staffId, freeAt, attendedToday });
      }
      continue;
    }

    if (!fitsSchedule(start, input.durationMin, s.blocks, timeZone)) {
      excluded.push({ kind: "excluded", staffId, reason: { code: "off_shift" } });
      continue;
    }

    const soon = bookingSoon(start.getTime());
    if (soon) {
      excluded.push({ kind: "excluded", staffId, reason: { code: "booking_soon", at: soon.start } });
      continue;
    }

    const lastAttended = Math.max(
      Number.NEGATIVE_INFINITY,
      ...todays.filter((a) => attendedBefore(a, now)).map((a) => a.end.getTime()),
    );
    const lastAway = Math.max(
      Number.NEGATIVE_INFINITY,
      ...input.timeOff
        .filter((t) => (t.staffId === null || t.staffId === staffId) && t.end.getTime() <= now.getTime() && t.end.getTime() > dayStart)
        .map((t) => t.end.getTime()),
    );
    // fitsSchedule(start) garantiza que `start` cae dentro de un bloque de hoy.
    const blockStart = currentBlockStart(start, s.blocks, timeZone)!.getTime();
    const freeSince = new Date(Math.min(now.getTime(), Math.max(blockStart, lastAttended, lastAway)));
    free.push({ kind: "free", staffId, freeSince, attendedToday });
  }

  const tie = (a: { staffId: bigint; attendedToday: number }, b: { staffId: bigint; attendedToday: number }) =>
    a.attendedToday - b.attendedToday || dailyRotation(today, a.staffId) - dailyRotation(today, b.staffId) || order(a.staffId, b.staffId);
  free.sort((a, b) => a.freeSince.getTime() - b.freeSince.getTime() || tie(a, b));
  busy.sort((a, b) => a.freeAt.getTime() - b.freeAt.getTime() || tie(a, b));
  excluded.sort((a, b) => order(a.staffId, b.staffId));
  return [...free, ...busy, ...excluded];
}
