import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fitsSchedule, isLateCancellation, occupiedRange, overlapsBusy, planWalkIn } from "./appointment";
import { localMinuteToInstant, MINUTE_MS } from "./clock";

const TZ = "America/Bogota";
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localMinuteToInstant("2026-11-02", h * 60 + m, TZ);
};
const ANDRES = 1n;
const BRAYAN = 2n;

describe("cita individual", () => {
  it("ocupa servicio + limpieza", () => {
    const r = occupiedRange(at("10:00"), 30, 10);
    expect(r.end.getTime() - r.start.getTime()).toBe(40 * MINUTE_MS);
  });

  it("cabe en el turno si el servicio (sin la limpieza) termina antes del cierre", () => {
    const blocks = [{ weekday: 1 as const, startMin: 9 * 60, endMin: 19 * 60 }];
    expect(fitsSchedule(at("18:30"), 30, blocks, TZ)).toBe(true);
    expect(fitsSchedule(at("18:45"), 30, blocks, TZ)).toBe(false);
    expect(fitsSchedule(at("08:45"), 30, blocks, TZ)).toBe(false);
  });

  it("un cierre de la sede bloquea a todos los barberos", () => {
    const busy = [{ staffId: null, start: at("12:00"), end: at("14:00") }];
    expect(overlapsBusy(ANDRES, occupiedRange(at("13:00"), 30, 0), busy)).toBe(true);
  });

  it("cancelar con menos de las horas gratuitas queda como tardía", () => {
    expect(isLateCancellation(at("08:00"), at("10:00"), 3)).toBe(true);
    expect(isLateCancellation(at("06:00"), at("10:00"), 3)).toBe(false);
  });
});

describe("walk-in", () => {
  it("empieza ya con quien esté libre y dice cuándo se libera el ocupado", () => {
    const plan = planWalkIn({
      now: at("10:07"),
      durationMin: 30,
      bufferMin: 5,
      staffIds: [ANDRES, BRAYAN],
      busy: [{ staffId: ANDRES, start: at("10:20"), end: at("11:00") }],
    });
    expect(plan.start).toEqual(at("10:05"));
    expect(plan.freeNow).toEqual([BRAYAN]);
    expect(plan.nextFree).toEqual([{ staffId: ANDRES, at: at("11:00") }]);
  });

  it("propiedad: nunca queda encima de una ocupación, ni ahora ni en el siguiente hueco", () => {
    const busyArb = fc
      .tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 1, max: 20 }))
      .map(([s, l]) => ({ staffId: ANDRES, start: at("09:00").getTime() + s * 5 * MINUTE_MS, len: l * 5 * MINUTE_MS }))
      .map((b) => ({ staffId: b.staffId, start: new Date(b.start), end: new Date(b.start + b.len) }));
    fc.assert(
      fc.property(fc.array(busyArb, { maxLength: 6 }), fc.integer({ min: 0, max: 400 }), fc.integer({ min: 1, max: 12 }), (busy, nowMin, dur5) => {
        const now = new Date(at("09:00").getTime() + nowMin * MINUTE_MS);
        const plan = planWalkIn({ now, durationMin: dur5 * 5, bufferMin: 5, staffIds: [ANDRES], busy });
        const start = plan.freeNow.length ? plan.start : plan.nextFree[0]!.at;
        expect(start.getTime()).toBeGreaterThanOrEqual(plan.start.getTime());
        expect(overlapsBusy(ANDRES, occupiedRange(start, dur5 * 5, 5), busy)).toBe(false);
      }),
    );
  });
});
