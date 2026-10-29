import type { ScheduleBlock } from "../staff/schedule";
import { datesBetween, isoWeekday, localMinuteToInstant, MINUTE_MS } from "./clock";
import { type Interval, overlapsAny } from "./interval";

// Horarios libres para reservar. Función pura: el llamador carga horarios, citas activas
// y ausencias; aquí solo se calcula. La garantía final contra la doble reserva está en
// Postgres (EXCLUDE); esto decide qué se ofrece.

export interface BusyInterval {
  /** null = toda la sede (p. ej. festivo). */
  readonly staffId: bigint | null;
  readonly start: Date;
  readonly end: Date;
}

export interface StaffAvailability {
  readonly staffId: bigint;
  readonly blocks: readonly ScheduleBlock[];
}

export interface AvailabilityInput {
  readonly timeZone: string;
  readonly now: Date;
  /** Fechas locales "yyyy-MM-dd", ambas incluidas. */
  readonly fromDate: string;
  readonly toDate: string;
  readonly durationMin: number;
  /** Limpieza después del servicio: ocupa la silla pero puede pasar del fin del turno. */
  readonly bufferMin: number;
  readonly stepMin: number;
  readonly minAdvanceMin: number;
  readonly maxAdvanceDays: number;
  readonly staff: readonly StaffAvailability[];
  readonly busy: readonly BusyInterval[];
}

export interface Slot {
  readonly start: Date;
  /** Barberos libres en ese horario, en el orden de `input.staff`. */
  readonly staffIds: bigint[];
}

export function availableSlots(input: AvailabilityInput): Slot[] {
  const { timeZone, durationMin, bufferMin, stepMin } = input;
  if (durationMin <= 0 || stepMin <= 0) return [];

  const earliest = input.now.getTime() + input.minAdvanceMin * MINUTE_MS;
  const latest = input.now.getTime() + input.maxAdvanceDays * 24 * 60 * MINUTE_MS;
  const occupiedMs = (durationMin + bufferMin) * MINUTE_MS;

  const locationBusy: Interval[] = [];
  const busyByStaff = new Map<bigint, Interval[]>();
  for (const b of input.busy) {
    const i = { start: b.start.getTime(), end: b.end.getTime() };
    if (b.staffId === null) locationBusy.push(i);
    else busyByStaff.set(b.staffId, [...(busyByStaff.get(b.staffId) ?? []), i]);
  }

  const byStart = new Map<number, bigint[]>();
  for (const date of datesBetween(input.fromDate, input.toDate)) {
    const weekday = isoWeekday(date);
    for (const member of input.staff) {
      const busy = [...locationBusy, ...(busyByStaff.get(member.staffId) ?? [])];
      for (const block of member.blocks) {
        if (block.weekday !== weekday) continue;
        // Inicios alineados a la grilla local (9:00, 9:15, …) dentro del bloque.
        const first = Math.ceil(block.startMin / stepMin) * stepMin;
        for (let m = first; m + durationMin <= block.endMin; m += stepMin) {
          const start = localMinuteToInstant(date, m, timeZone).getTime();
          if (start < earliest || start >= latest) continue;
          if (overlapsAny({ start, end: start + occupiedMs }, busy)) continue;
          const ids = byStart.get(start) ?? [];
          if (!ids.includes(member.staffId)) ids.push(member.staffId);
          byStart.set(start, ids);
        }
      }
    }
  }

  const order = new Map(input.staff.map((s, i) => [s.staffId, i]));
  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, staffIds]) => ({
      start: new Date(start),
      staffIds: staffIds.sort((a, b) => order.get(a)! - order.get(b)!),
    }));
}

/**
 * "Cualquiera": el barbero con menos minutos agendados ese día; empate, el de id menor.
 * Reparte el trabajo sin que recepción tenga que pensarlo.
 */
export function pickStaffForAny(staffIds: readonly bigint[], bookedMinutes: ReadonlyMap<bigint, number>): bigint {
  if (staffIds.length === 0) throw new Error("No hay barberos libres en ese horario");
  return [...staffIds].sort((a, b) => (bookedMinutes.get(a) ?? 0) - (bookedMinutes.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))[0]!;
}
