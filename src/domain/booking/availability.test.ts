import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ScheduleBlock, Weekday } from "../staff/schedule";
import { type AvailabilityInput, availableSlots, type BusyInterval, pickStaffForAny } from "./availability";
import { isoWeekday, localMinuteOf, localMinuteToInstant, MINUTE_MS } from "./clock";

const TZ = "America/Bogota";
const DAY = "2026-11-02"; // lunes
const at = (hhmm: string, date = DAY) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localMinuteToInstant(date, h * 60 + m, TZ);
};
const hhmm = (d: Date) => {
  const m = localMinuteOf(d, TZ);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

const ANDRES = 1n;
const BRAYAN = 2n;
const lunes = (start: number, end: number): ScheduleBlock => ({ weekday: 1, startMin: start, endMin: end });

const base: AvailabilityInput = {
  timeZone: TZ,
  now: at("06:00"),
  fromDate: DAY,
  toDate: DAY,
  durationMin: 30,
  bufferMin: 0,
  stepMin: 30,
  minAdvanceMin: 0,
  maxAdvanceDays: 14,
  staff: [{ staffId: ANDRES, blocks: [lunes(9 * 60, 11 * 60)] }],
  busy: [],
};

describe("hora local de la sede", () => {
  it("Bogotá es UTC−5: 9:00 local son las 14:00 UTC", () => {
    expect(at("09:00").toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(localMinuteToInstant(DAY, 1440, TZ).toISOString()).toBe("2026-11-03T05:00:00.000Z");
    expect(isoWeekday("2026-11-08")).toBe(7);
  });
});

describe("horarios disponibles", () => {
  it("ofrece los inicios de la grilla que caben en el turno", () => {
    expect(availableSlots(base).map((s) => hhmm(s.start))).toEqual(["09:00", "09:30", "10:00", "10:30"]);
  });

  it("la limpieza ocupa la silla: no se ofrece un horario cuya limpieza choca con otra cita", () => {
    const busy: BusyInterval[] = [{ staffId: ANDRES, start: at("10:00"), end: at("10:30") }];
    const slots = availableSlots({ ...base, bufferMin: 10, busy });
    expect(slots.map((s) => hhmm(s.start))).toEqual(["09:00", "10:30"]);
  });

  it("la limpieza puede pasar del fin del turno; el servicio no", () => {
    const slots = availableSlots({ ...base, bufferMin: 15 });
    expect(slots.map((s) => hhmm(s.start)).at(-1)).toBe("10:30");
  });

  it("respeta la anticipación mínima y un cierre de toda la sede", () => {
    const slots = availableSlots({
      ...base,
      now: at("08:45"),
      minAdvanceMin: 60,
      busy: [{ staffId: null, start: at("10:30"), end: at("12:00") }],
    });
    expect(slots.map((s) => hhmm(s.start))).toEqual(["10:00"]);
  });

  it('"Cualquiera" junta a los barberos libres y reparte al de menos carga', () => {
    const slots = availableSlots({
      ...base,
      staff: [
        { staffId: ANDRES, blocks: [lunes(9 * 60, 10 * 60)] },
        { staffId: BRAYAN, blocks: [lunes(9 * 60 + 30, 10 * 60 + 30)] },
      ],
    });
    expect(slots.map((s) => [hhmm(s.start), s.staffIds])).toEqual([
      ["09:00", [ANDRES]],
      ["09:30", [ANDRES, BRAYAN]],
      ["10:00", [BRAYAN]],
    ]);
    expect(pickStaffForAny([ANDRES, BRAYAN], new Map([[ANDRES, 90], [BRAYAN, 30]]))).toBe(BRAYAN);
    expect(pickStaffForAny([BRAYAN, ANDRES], new Map())).toBe(ANDRES);
  });
});

// ─── Propiedades ──────────────────────────────────────────────────────────────

const STAFF = [1n, 2n, 3n];
const blockArb = fc
  .tuple(fc.integer({ min: 1, max: 7 }), fc.integer({ min: 72, max: 250 }), fc.integer({ min: 2, max: 40 }))
  .map(([weekday, start5, len5]) => ({
    weekday: weekday as Weekday,
    startMin: start5 * 5,
    endMin: Math.min(start5 * 5 + len5 * 5, 1440),
  }));
const busyArb = fc
  .tuple(fc.constantFrom<bigint | null>(null, ...STAFF), fc.integer({ min: 0, max: 7 * 288 }), fc.integer({ min: 1, max: 36 }))
  .map(([staffId, start5, len5]) => {
    const start = localMinuteToInstant(DAY, start5 * 5, TZ);
    return { staffId, start, end: new Date(start.getTime() + len5 * 5 * MINUTE_MS) };
  });
const inputArb = fc
  .record({
    staff: fc.uniqueArray(fc.record({ staffId: fc.constantFrom(...STAFF), blocks: fc.array(blockArb, { maxLength: 3 }) }), {
      maxLength: 3,
      selector: (s) => s.staffId,
    }),
    busy: fc.array(busyArb, { maxLength: 8 }),
    durationMin: fc.integer({ min: 1, max: 24 }).map((n) => n * 5),
    bufferMin: fc.integer({ min: 0, max: 4 }).map((n) => n * 5),
    stepMin: fc.constantFrom(5, 10, 15, 30),
    nowMin: fc.integer({ min: 0, max: 3 * 1440 }),
    minAdvanceMin: fc.integer({ min: 0, max: 240 }),
  })
  .map(({ nowMin, ...p }): AvailabilityInput => ({
    ...base,
    ...p,
    toDate: "2026-11-08",
    now: localMinuteToInstant(DAY, nowMin, TZ),
    maxAdvanceDays: 5,
  }));

const occupied = (input: AvailabilityInput) => (input.durationMin + input.bufferMin) * MINUTE_MS;

// Oráculo: la definición literal de "horario disponible", con aritmética simple e independiente
// del código que se prueba. Bogotá es UTC−5 fijo; DAY es lunes, así que el día ISO es 1 + días.
const DAY_START = Date.UTC(2026, 10, 2, 5); // 2026-11-02 00:00 en Bogotá

function oracle(input: AvailabilityInput, staffId: bigint, start: Date): boolean {
  const member = input.staff.find((s) => s.staffId === staffId);
  if (!member) return false;
  const t = start.getTime();
  if (t < input.now.getTime() + input.minAdvanceMin * MINUTE_MS) return false;
  if (t >= input.now.getTime() + input.maxAdvanceDays * 1440 * MINUTE_MS) return false;
  const sinceMonday = Math.floor((t - DAY_START) / MINUTE_MS);
  const weekday = Math.floor(sinceMonday / 1440) + 1;
  const min = sinceMonday % 1440;
  if (min % input.stepMin !== 0) return false;
  const inBlock = member.blocks.some((b) => b.weekday === weekday && b.startMin <= min && min + input.durationMin <= b.endMin);
  if (!inBlock) return false;
  const end = t + occupied(input);
  return !input.busy.some((b) => (b.staffId === null || b.staffId === staffId) && b.start.getTime() < end && t < b.end.getTime());
}

const keys = (slots: ReturnType<typeof availableSlots>) =>
  new Set(slots.flatMap((s) => s.staffIds.map((id) => `${id}@${s.start.getTime()}`)));

describe("propiedades de disponibilidad", () => {
  it("coincide con el oráculo en ambos sentidos: nada inválido se ofrece y nada válido falta", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const slots = availableSlots(input);
        for (const s of slots) for (const id of s.staffIds) expect(oracle(input, id, s.start)).toBe(true);
        const offered = keys(slots);
        for (const member of input.staff) {
          for (let m = 0; m < 7 * 1440; m += input.stepMin) {
            const start = new Date(DAY_START + m * MINUTE_MS);
            if (oracle(input, member.staffId, start)) expect(offered.has(`${member.staffId}@${start.getTime()}`)).toBe(true);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it("los inicios van en orden estricto y agregar una ocupación nunca agrega horarios", () => {
    fc.assert(
      fc.property(inputArb, busyArb, (input, extra) => {
        const before = availableSlots(input);
        for (let i = 1; i < before.length; i++) expect(before[i]!.start.getTime()).toBeGreaterThan(before[i - 1]!.start.getTime());
        const had = keys(before);
        for (const k of keys(availableSlots({ ...input, busy: [...input.busy, extra] }))) expect(had.has(k)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("al reservar un horario, ningún horario que se ofrezca después lo pisa para ese barbero", () => {
    fc.assert(
      fc.property(inputArb, fc.nat(), (input, pick) => {
        const slots = availableSlots(input);
        fc.pre(slots.length > 0);
        const slot = slots[pick % slots.length]!;
        const staffId = slot.staffIds[0]!;
        const booked = { staffId, start: slot.start, end: new Date(slot.start.getTime() + occupied(input)) };
        for (const s of availableSlots({ ...input, busy: [...input.busy, booked] })) {
          if (!s.staffIds.includes(staffId)) continue;
          const end = s.start.getTime() + occupied(input);
          expect(s.start.getTime() < booked.end.getTime() && booked.start.getTime() < end).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
