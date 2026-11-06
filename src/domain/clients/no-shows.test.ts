import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NO_SHOW_WINDOW_DAYS, noShowNotice, noShowStanding } from "./no-shows";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-05T20:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY);

describe("faltas y reserva en línea", () => {
  it("con 2 faltas se suspende; con 1, no", () => {
    expect(noShowStanding({ markedAt: [daysAgo(3)], clearedAt: null, now, limit: 2 })).toEqual({ count: 1, limit: 2, suspended: false });
    expect(noShowStanding({ markedAt: [daysAgo(3), daysAgo(40)], clearedAt: null, now, limit: 2 })).toEqual({ count: 2, limit: 2, suspended: true });
  });

  it("al desbloquear, las faltas anteriores dejan de contar; una nueva vuelve a contar", () => {
    const marked = [daysAgo(10), daysAgo(5)];
    expect(noShowStanding({ markedAt: marked, clearedAt: daysAgo(1), now, limit: 2 }).suspended).toBe(false);
    expect(noShowStanding({ markedAt: [...marked, new Date(now.getTime() - 1000)], clearedAt: daysAgo(1), now, limit: 2 }).count).toBe(1);
  });

  it("las faltas de hace más de la ventana no cuentan", () => {
    const s = noShowStanding({ markedAt: [daysAgo(NO_SHOW_WINDOW_DAYS + 1), daysAgo(2)], clearedAt: null, now, limit: 2 });
    expect(s).toEqual({ count: 1, limit: 2, suspended: false });
  });

  it("una falta marcada en el mismo instante del desbloqueo ya quedó perdonada", () => {
    const at = daysAgo(1);
    expect(noShowStanding({ markedAt: [at, at], clearedAt: at, now, limit: 2 }).count).toBe(0);
  });

  it("el aviso para el personal", () => {
    expect(noShowNotice({ count: 0, limit: 2, suspended: false })).toBeNull();
    expect(noShowNotice({ count: 1, limit: 2, suspended: false })).toBe("1 falta (con 2 se suspende la reserva en línea)");
    expect(noShowNotice({ count: 2, limit: 2, suspended: true })).toBe("Reserva en línea suspendida: 2 faltas");
  });

  const marks = fc.array(fc.integer({ min: -400, max: 0 }).map((d) => new Date(now.getTime() + d * DAY + 1)), { maxLength: 8 });
  const cleared = fc.option(fc.integer({ min: -400, max: 0 }).map((d) => new Date(now.getTime() + d * DAY)), { nil: null });
  const limit = fc.integer({ min: 1, max: 10 });

  it("propiedad: coincide con el modelo de referencia, con marcas futuras y en los bordes de la ventana y del desbloqueo", () => {
    const windowStart = now.getTime() - NO_SHOW_WINDOW_DAYS * DAY;
    const edgy = fc.oneof(
      fc.integer({ min: -400 * 24, max: 48 }).map((h) => new Date(now.getTime() + h * 60 * 60 * 1000)),
      fc.constantFrom(new Date(windowStart), new Date(windowStart + 1), new Date(now.getTime()), new Date(now.getTime() + 1)),
    );
    fc.assert(
      fc.property(fc.array(edgy, { maxLength: 10 }), fc.option(edgy, { nil: null }), limit, (markedAt, clearedAt, lim) => {
        const from = Math.max(windowStart, clearedAt?.getTime() ?? -Infinity);
        const expected = markedAt.filter((t) => t.getTime() > from && t.getTime() <= now.getTime()).length;
        expect(noShowStanding({ markedAt, clearedAt, now, limit: lim })).toEqual({ count: expected, limit: lim, suspended: expected >= lim });
      }),
      { numRuns: 500 },
    );
  });

  it("propiedad: suspendido ⇔ las faltas que cuentan llegan al límite, y nunca cuenta más de las que hay", () => {
    fc.assert(
      fc.property(marks, cleared, limit, (markedAt, clearedAt, lim) => {
        const s = noShowStanding({ markedAt, clearedAt, now, limit: lim });
        expect(s.suspended).toBe(s.count >= lim);
        expect(s.count).toBeLessThanOrEqual(markedAt.length);
      }),
    );
  });

  it("propiedad: desbloquear nunca deja a nadie más suspendido, y justo al desbloquear nadie queda suspendido", () => {
    fc.assert(
      fc.property(marks, cleared, limit, (markedAt, clearedAt, lim) => {
        const before = noShowStanding({ markedAt, clearedAt, now, limit: lim });
        const after = noShowStanding({ markedAt, clearedAt: now, now, limit: lim });
        expect(after.count).toBeLessThanOrEqual(before.count);
        expect(after.suspended).toBe(false);
      }),
    );
  });

  it("propiedad: una falta más nunca baja el conteo, y el orden de las faltas no importa", () => {
    fc.assert(
      fc.property(marks, cleared, limit, fc.integer({ min: -400, max: 0 }), (markedAt, clearedAt, lim, d) => {
        const base = noShowStanding({ markedAt, clearedAt, now, limit: lim });
        const more = noShowStanding({ markedAt: [...markedAt, new Date(now.getTime() + d * DAY)], clearedAt, now, limit: lim });
        expect(more.count).toBeGreaterThanOrEqual(base.count);
        expect(noShowStanding({ markedAt: [...markedAt].reverse(), clearedAt, now, limit: lim })).toEqual(base);
      }),
    );
  });
});
