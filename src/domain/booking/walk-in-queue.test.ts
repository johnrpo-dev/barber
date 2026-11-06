import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ScheduleBlock } from "../staff/schedule";
import { fitsSchedule } from "./appointment";
import { floorToStep, localMinuteToInstant, MINUTE_MS } from "./clock";
import { overlapsAny } from "./interval";
import type { AppointmentStatus } from "./status";
import { type QueueAppointment, type QueueEntry, type QueueStaff, type QueueTimeOff, walkInQueue, type WalkInQueueInput } from "./walk-in-queue";

const TZ = "America/Bogota";
const DAY = "2026-11-05"; // jueves
const at = (hour: number, minute = 0) => localMinuteToInstant(DAY, hour * 60 + minute, TZ);
const allWeek = (startMin: number, endMin: number): ScheduleBlock[] =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday: weekday as ScheduleBlock["weekday"], startMin, endMin }));
/** De 8 a 13 y de 14 a 20 (almuerzo de 1 a 2). */
const SHIFT: ScheduleBlock[] = [...allWeek(8 * 60, 13 * 60), ...allWeek(14 * 60, 20 * 60)];

const SERGIO = 1n;
const ANDRES = 2n;
const FELIPE = 3n;
const barber = (staffId: bigint, blocks = SHIFT, offersService = true): QueueStaff => ({ staffId, blocks, offersService });
const appt = (staffId: bigint, status: AppointmentStatus, start: Date, end: Date, expiresAt: Date | null = null): QueueAppointment => ({
  staffId,
  status,
  start,
  end,
  expiresAt,
});

function queue(over: Partial<WalkInQueueInput>) {
  return walkInQueue({
    now: at(15, 10),
    timeZone: TZ,
    durationMin: 30,
    bufferMin: 5,
    guardMin: 60,
    staff: [barber(SERGIO), barber(ANDRES), barber(FELIPE)],
    appointments: [],
    timeOff: [],
    ...over,
  });
}
const freeIds = (q: QueueEntry[]) => q.filter((e) => e.kind === "free").map((e) => e.staffId);

/** El ejemplo del dueño: Sergio terminó a las 2:41, Andrés a las 2:58 y Felipe a las 3:05. */
const owners = () => [
  appt(SERGIO, "completed", at(14, 10), at(14, 41)),
  appt(ANDRES, "completed", at(14, 20), at(14, 58)),
  appt(FELIPE, "completed", at(14, 30), at(15, 5)),
];

describe("la fila del walk-in", () => {
  it("el ejemplo del dueño: primero el que terminó primero", () => {
    const q = queue({ appointments: owners() });
    expect(freeIds(q)).toEqual([SERGIO, ANDRES, FELIPE]);
    expect(q[0]).toMatchObject({ kind: "free", freeSince: at(14, 41) });
  });

  it("con una cita en menos de 60 minutos no está disponible; justo a los 60, sí", () => {
    const soon = queue({ appointments: [...owners(), appt(SERGIO, "confirmed", at(16, 0), at(16, 35))] });
    expect(freeIds(soon)).toEqual([ANDRES, FELIPE]);
    expect(soon.find((e) => e.staffId === SERGIO)).toMatchObject({ kind: "excluded", reason: { code: "booking_soon", at: at(16, 0) } });
    // Son las 3:10: la cita de las 4:10 queda justo a 60 minutos.
    const exact = queue({ appointments: [...owners(), appt(SERGIO, "confirmed", at(16, 10), at(16, 45))] });
    expect(freeIds(exact)[0]).toBe(SERGIO);
  });

  it("un servicio largo no se monta sobre la cita siguiente aunque falten más de 60 minutos", () => {
    const q = queue({ durationMin: 60, bufferMin: 5, appointments: [...owners(), appt(SERGIO, "confirmed", at(16, 12), at(16, 47))] });
    expect(freeIds(q)).not.toContain(SERGIO);
  });

  it("una retención vencida no cuenta como cita; una vigente, sí", () => {
    const expired = queue({ appointments: [...owners(), appt(SERGIO, "pending", at(15, 40), at(16, 15), at(15, 0))] });
    expect(freeIds(expired)[0]).toBe(SERGIO);
    const live = queue({ appointments: [...owners(), appt(SERGIO, "pending", at(15, 40), at(16, 15), at(15, 20))] });
    expect(freeIds(live)).not.toContain(SERGIO);
  });

  it("después del almuerzo cuenta desde el regreso, no desde la mañana", () => {
    // Sergio terminó a las 11 y almorzó; Andrés terminó a las 2:05 p. m. y Felipe a las 2:25. Son las 2:30.
    const q = queue({
      now: at(14, 30),
      appointments: [
        appt(SERGIO, "completed", at(10, 30), at(11, 0)),
        appt(ANDRES, "completed", at(13, 30), at(14, 5)),
        appt(FELIPE, "completed", at(14, 0), at(14, 25)),
      ],
    });
    expect(q.flatMap((e) => (e.kind === "free" ? [[e.staffId, e.freeSince]] : []))).toEqual([
      [SERGIO, at(14, 0)],
      [ANDRES, at(14, 5)],
      [FELIPE, at(14, 25)],
    ]);
  });

  it("un No vino o una cancelación no le quitan el puesto", () => {
    const base = queue({ appointments: owners() });
    const withNoise = queue({
      appointments: [...owners(), appt(SERGIO, "no_show", at(14, 45), at(15, 20)), appt(ANDRES, "cancelled", at(15, 0), at(15, 35))],
    });
    expect(withNoise).toEqual(base);
  });

  it("en la silla: va después de los libres con la hora en que se libera; pasado de la hora, no se elige solo", () => {
    const busy = queue({ appointments: [...owners().slice(1), appt(SERGIO, "in_chair", at(14, 50), at(15, 25))] });
    expect(busy.map((e) => e.kind)).toEqual(["free", "free", "busy"]);
    expect(busy[2]).toMatchObject({ staffId: SERGIO, freeAt: at(15, 25) });
    const overdue = queue({ appointments: [...owners().slice(1), appt(SERGIO, "in_chair", at(14, 30), at(15, 5))] });
    expect(overdue.find((e) => e.staffId === SERGIO)).toMatchObject({ kind: "excluded", reason: { code: "overdue_in_chair" } });
  });

  it("ocupado que al liberarse tiene una cita dentro del margen: no entra", () => {
    const q = queue({
      appointments: [...owners().slice(1), appt(SERGIO, "in_chair", at(14, 50), at(15, 25)), appt(SERGIO, "confirmed", at(16, 0), at(16, 35))],
    });
    expect(q.find((e) => e.staffId === SERGIO)).toMatchObject({ kind: "excluded", reason: { code: "booking_soon" } });
  });

  it("un cliente con cita que ya llegó y espera ocupa al barbero", () => {
    const q = queue({ appointments: [...owners(), appt(SERGIO, "arrived", at(15, 0), at(15, 35))] });
    expect(freeIds(q)).not.toContain(SERGIO);
  });

  it("un \"Llegó\" olvidado pasado de su hora no lo deja ocupado todo el día: sale con el motivo", () => {
    const q = queue({ now: at(17, 0), appointments: [...owners().slice(1), appt(SERGIO, "arrived", at(15, 0), at(15, 35))] });
    expect(q.find((e) => e.staffId === SERGIO)).toMatchObject({ kind: "excluded", reason: { code: "overdue_in_chair" } });
  });

  it("libre ahora pero el servicio no alcanza antes de su descanso: ocupado, marcado como libre ahora", () => {
    const q = queue({ now: at(12, 45), appointments: [] });
    expect(q.every((e) => e.kind === "excluded" && e.reason.code === "off_shift")).toBe(true);
    const lunchSoon = queue({ now: at(10, 10), timeOff: [{ staffId: SERGIO, start: at(10, 30), end: at(10, 50) }] });
    expect(lunchSoon.find((e) => e.staffId === SERGIO)).toMatchObject({ kind: "busy", idleNow: true, freeAt: at(10, 50) });
  });

  it("sin servicios hoy, cuenta desde el inicio del bloque; lo de ayer no cuenta", () => {
    const yesterday = new Date(at(18, 0).getTime() - 24 * 60 * MINUTE_MS);
    const q = queue({ now: at(9, 0), appointments: [appt(SERGIO, "completed", yesterday, new Date(yesterday.getTime() + 35 * MINUTE_MS))] });
    const free = q.filter((e) => e.kind === "free");
    expect(free).toHaveLength(3);
    expect(free.every((e) => e.kind === "free" && e.freeSince.getTime() === at(8, 0).getTime())).toBe(true);
  });

  it("fuera del turno, sin el servicio o en una ausencia: no entra, con el motivo", () => {
    const q = queue({
      now: at(19, 50),
      staff: [barber(SERGIO), barber(ANDRES, SHIFT, false), barber(FELIPE)],
      timeOff: [{ staffId: FELIPE, start: at(19, 0), end: at(20, 0) }],
    });
    expect(q.map((e) => (e.kind === "excluded" ? e.reason.code : e.kind))).toEqual(["off_shift", "not_offered", "away"]);
  });

  it("Salí / Llegué: quien salió queda fuera; al volver entra de último entre los libres", () => {
    const out = queue({ appointments: owners(), staff: [{ ...barber(SERGIO), presence: { outSince: at(14, 50), backAt: null } }, barber(ANDRES), barber(FELIPE)] });
    expect(freeIds(out)).toEqual([ANDRES, FELIPE]);
    expect(out.find((e) => e.staffId === SERGIO)).toEqual({ kind: "excluded", staffId: SERGIO, reason: { code: "out", since: at(14, 50) } });
    // Volvió a las 3:08: Felipe terminó a las 3:05, así que Sergio queda detrás de él.
    const back = queue({ appointments: owners(), staff: [{ ...barber(SERGIO), presence: { outSince: null, backAt: at(15, 8) } }, barber(ANDRES), barber(FELIPE)] });
    expect(freeIds(back)).toEqual([ANDRES, FELIPE, SERGIO]);
    expect(back[2]).toMatchObject({ freeSince: at(15, 8) });
    // Lo de ayer no cuenta: una vuelta de ayer no cambia nada.
    const yesterday = queue({ appointments: owners(), staff: [{ ...barber(SERGIO), presence: { outSince: null, backAt: at(-10, 0) } }, barber(ANDRES), barber(FELIPE)] });
    expect(freeIds(yesterday)).toEqual([SERGIO, ANDRES, FELIPE]);
  });

  it("empate: primero quien menos ha atendido hoy", () => {
    const blocks = allWeek(8 * 60 + 55, 20 * 60);
    const q = queue({
      now: at(9, 0),
      appointments: [appt(SERGIO, "completed", at(8, 0), at(8, 30)), appt(SERGIO, "completed", at(8, 30), at(8, 55))],
      staff: [barber(SERGIO, blocks), barber(ANDRES, blocks)],
    });
    expect(freeIds(q)).toEqual([ANDRES, SERGIO]);
  });
});

// ─── Propiedades ─────────────────────────────────────────────────────────────

const STAFF_IDS = [1n, 2n, 3n, 4n, 5n];
const STATUSES: AppointmentStatus[] = ["pending", "confirmed", "arrived", "in_chair", "completed", "cancelled", "no_show"];

const scenario = fc.record({
  nowMin: fc.integer({ min: 7 * 60, max: 21 * 60 }),
  durationMin: fc.constantFrom(15, 30, 45, 60),
  bufferMin: fc.constantFrom(0, 5, 10),
  guardMin: fc.constantFrom(0, 30, 60, 90),
  staff: fc.uniqueArray(fc.record({ staffId: fc.constantFrom(...STAFF_IDS), offersService: fc.constantFrom(true, true, true, false) }), {
    minLength: 1,
    maxLength: 5,
    selector: (s) => s.staffId,
  }),
  appointments: fc.array(
    fc.record({
      staffId: fc.constantFrom(...STAFF_IDS),
      status: fc.constantFrom(...STATUSES),
      startMin: fc.integer({ min: 7 * 60, max: 21 * 60 }),
      lengthMin: fc.integer({ min: 10, max: 90 }),
      expiresInMin: fc.integer({ min: -30, max: 30 }),
    }),
    { maxLength: 14 },
  ),
  timeOff: fc.array(
    fc.record({ staffId: fc.constantFrom(...STAFF_IDS), startMin: fc.integer({ min: 7 * 60, max: 21 * 60 }), lengthMin: fc.integer({ min: 15, max: 120 }) }),
    { maxLength: 3 },
  ),
});

function build(s: fc.Arbitrary<unknown> extends never ? never : ReturnType<typeof scenario.generate>["value"]): WalkInQueueInput {
  const now = at(0, s.nowMin);
  return {
    now,
    timeZone: TZ,
    durationMin: s.durationMin,
    bufferMin: s.bufferMin,
    guardMin: s.guardMin,
    staff: s.staff.map((x) => barber(x.staffId, SHIFT, x.offersService)),
    appointments: s.appointments.map((a) =>
      appt(a.staffId, a.status, at(0, a.startMin), at(0, a.startMin + a.lengthMin), a.status === "pending" ? new Date(now.getTime() + a.expiresInMin * MINUTE_MS) : null),
    ),
    timeOff: s.timeOff.map((t): QueueTimeOff => ({ staffId: t.staffId, start: at(0, t.startMin), end: at(0, t.startMin + t.lengthMin) })),
  };
}

describe("propiedades de la fila del walk-in", () => {
  it("cada barbero aparece una sola vez: libres (por libre desde), luego ocupados, luego los que no pueden", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const q = walkInQueue(build(s));
        expect(q.map((e) => e.staffId).sort()).toEqual(s.staff.map((x) => x.staffId).sort());
        const rank = { free: 0, busy: 1, excluded: 2 } as const;
        for (let i = 1; i < q.length; i++) expect(rank[q[i - 1]!.kind]).toBeLessThanOrEqual(rank[q[i]!.kind]);
        const free = q.flatMap((e) => (e.kind === "free" ? [e.freeSince.getTime()] : []));
        for (let i = 1; i < free.length; i++) expect(free[i - 1]!).toBeLessThanOrEqual(free[i]!);
      }),
      { numRuns: 300 },
    );
  });

  it("todo barbero libre cumple las reglas: hace el servicio, está en turno, la silla está libre y no tiene cita dentro del margen", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const input = build(s);
        const start = floorToStep(input.now, 5);
        const slot = { start: start.getTime(), end: start.getTime() + (input.durationMin + input.bufferMin) * MINUTE_MS };
        for (const e of walkInQueue(input)) {
          if (e.kind !== "free") continue;
          const st = input.staff.find((x) => x.staffId === e.staffId)!;
          expect(st.offersService).toBe(true);
          expect(fitsSchedule(start, input.durationMin, st.blocks, TZ)).toBe(true);
          const live = input.appointments.filter(
            (a) =>
              a.staffId === e.staffId &&
              (["confirmed", "arrived", "in_chair", "completed"].includes(a.status) || (a.status === "pending" && a.expiresAt! > input.now)),
          );
          const blocks = [...live, ...input.timeOff.filter((t) => t.staffId === e.staffId)].map((x) => ({ start: x.start.getTime(), end: x.end.getTime() }));
          expect(overlapsAny(slot, blocks)).toBe(false);
          const soon = live.some(
            (a) =>
              ["pending", "confirmed", "arrived"].includes(a.status) &&
              a.start.getTime() >= slot.start &&
              a.start.getTime() < slot.start + input.guardMin * MINUTE_MS,
          );
          expect(soon).toBe(false);
          expect(e.freeSince.getTime()).toBeLessThanOrEqual(input.now.getTime());
        }
      }),
      { numRuns: 300 },
    );
  });

  it("todo barbero apto sin nada en su agenda ni ausencias entra como libre (la otra dirección)", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const input = build(s);
        const start = floorToStep(input.now, 5);
        const q = walkInQueue(input);
        for (const st of input.staff) {
          const hasAppointments = input.appointments.some((a) => a.staffId === st.staffId && !["cancelled", "no_show"].includes(a.status));
          const hasTimeOff = input.timeOff.some((t) => t.staffId === null || t.staffId === st.staffId);
          if (!st.offersService || hasAppointments || hasTimeOff || !fitsSchedule(start, input.durationMin, st.blocks, TZ)) continue;
          expect(q.find((e) => e.staffId === st.staffId)?.kind).toBe("free");
        }
      }),
      { numRuns: 300 },
    );
  });

  it("no depende del orden de los datos, y las canceladas y los No vino no cambian nada", () => {
    fc.assert(
      fc.property(scenario, fc.integer(), (s, seed) => {
        const input = build(s);
        const shuffle = <T,>(xs: readonly T[]) =>
          xs
            .map((x, i) => ({ x, k: Math.sin(seed + i * 7.1) }))
            .sort((a, b) => a.k - b.k)
            .map((p) => p.x);
        const base = walkInQueue(input);
        expect(walkInQueue({ ...input, staff: shuffle(input.staff), appointments: shuffle(input.appointments), timeOff: shuffle(input.timeOff) })).toEqual(base);
        const kept = input.appointments.filter((a) => a.status !== "cancelled" && a.status !== "no_show");
        const noise = input.appointments.map((a): QueueAppointment => ({ ...a, status: a.staffId % 2n === 0n ? "cancelled" : "no_show" }));
        expect(walkInQueue({ ...input, appointments: [...kept, ...noise] })).toEqual(walkInQueue({ ...input, appointments: kept }));
      }),
      { numRuns: 200 },
    );
  });

  it("Salí / Llegué: quien está fuera nunca entra a la fila; quien volvió nunca va antes de su regreso", () => {
    const presence = fc.uniqueArray(
      fc.record({ staffId: fc.constantFrom(...STAFF_IDS), out: fc.boolean(), backMin: fc.option(fc.integer({ min: 7 * 60, max: 21 * 60 }), { nil: null }) }),
      { maxLength: 5, selector: (p) => p.staffId },
    );
    fc.assert(
      fc.property(scenario, presence, (s, marks) => {
        const input = build(s);
        const staff = input.staff.map((st): QueueStaff => {
          const m = marks.find((x) => x.staffId === st.staffId);
          if (!m) return st;
          const backAt = m.backMin === null ? null : at(0, m.backMin);
          return { ...st, presence: { outSince: m.out ? (backAt ?? at(7, 0)) : null, backAt: m.out ? null : backAt } };
        });
        const q = walkInQueue({ ...input, staff });
        for (const st of staff) {
          const e = q.find((x) => x.staffId === st.staffId)!;
          if (st.offersService && st.presence?.outSince) expect(e).toMatchObject({ kind: "excluded", reason: { code: "out" } });
          const back = st.presence?.backAt;
          if (e.kind === "free" && back && back.getTime() <= input.now.getTime()) expect(e.freeSince.getTime()).toBeGreaterThanOrEqual(back.getTime());
        }
        // Sin marcas, la fila es la de siempre.
        expect(walkInQueue({ ...input, staff: input.staff.map((st) => ({ ...st, presence: { outSince: null, backAt: null } })) })).toEqual(walkInQueue(input));
      }),
      { numRuns: 300 },
    );
  });

  it("terminar más tarde nunca adelanta a un barbero en la fila", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 1, max: 20 }), (finish, later) => {
        const others = [appt(ANDRES, "completed", at(14, 0), at(14, 20)), appt(FELIPE, "completed", at(14, 0), at(14, 25))];
        const pos = (end: Date) => freeIds(queue({ appointments: [...others, appt(SERGIO, "completed", at(14, 0), end)] })).indexOf(SERGIO);
        expect(pos(at(14, 15 + Math.min(finish + later, 55)))).toBeGreaterThanOrEqual(pos(at(14, 15 + finish)));
      }),
      { numRuns: 200 },
    );
  });

  it("simulación: con walk-ins iguales y sin citas, el reparto entre barberos difiere a lo sumo en uno", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 5, maxLength: 40 }),
        fc.constantFrom(20, 30, 45),
        (n, gaps, durationMin) => {
          const staff = STAFF_IDS.slice(0, n).map((id) => barber(id));
          const appointments: QueueAppointment[] = [];
          const count = new Map<bigint, number>(staff.map((s) => [s.staffId, 0]));
          let t = at(8, 0).getTime();
          for (const gap of gaps) {
            t += gap * MINUTE_MS;
            const now = new Date(t);
            if (now.getTime() >= at(12, 0).getTime()) break;
            const first = walkInQueue({ now, timeZone: TZ, durationMin, bufferMin: 5, guardMin: 60, staff, appointments, timeOff: [] }).find(
              (e) => e.kind === "free",
            );
            if (!first) continue;
            const start = floorToStep(now, 5);
            appointments.push(appt(first.staffId, "completed", start, new Date(start.getTime() + (durationMin + 5) * MINUTE_MS)));
            count.set(first.staffId, count.get(first.staffId)! + 1);
          }
          const values = [...count.values()];
          expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
