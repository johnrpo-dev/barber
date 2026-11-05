import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Weekday } from "@/domain/staff/schedule";
import { openStatus, openStatusLabel, type DayHours } from "./open-status";

const h = (hours: number, minutes = 0) => hours * 60 + minutes;

// Lunes a sábado 8:00–12:00 y 13:00–21:00; domingo cerrado.
const WEEK: DayHours[] = ([1, 2, 3, 4, 5, 6] as const).map((weekday) => ({
  weekday,
  ranges: [
    { start: h(8), end: h(12) },
    { start: h(13), end: h(21) },
  ],
}));

describe("openStatus", () => {
  it("abierto dentro de un rango: cierra al final de ese rango", () => {
    expect(openStatus(WEEK, 2, h(10))).toEqual({ open: true, closesAt: h(12) });
    expect(openStatus(WEEK, 2, h(8))).toEqual({ open: true, closesAt: h(12) });
    expect(openStatus(WEEK, 2, h(20, 59))).toEqual({ open: true, closesAt: h(21) });
  });

  it("el fin del rango es abierto: a las 21:00 ya cerró", () => {
    expect(openStatus(WEEK, 2, h(21)).open).toBe(false);
  });

  it("en el almuerzo: abre hoy mismo", () => {
    expect(openStatus(WEEK, 3, h(12, 30))).toEqual({ open: false, opensAt: { daysAhead: 0, weekday: 3, minute: h(13) } });
  });

  it("antes de abrir: abre hoy", () => {
    expect(openStatus(WEEK, 1, h(6))).toEqual({ open: false, opensAt: { daysAhead: 0, weekday: 1, minute: h(8) } });
  });

  it("sábado en la noche: salta el domingo cerrado y abre el lunes", () => {
    expect(openStatus(WEEK, 6, h(22))).toEqual({ open: false, opensAt: { daysAhead: 2, weekday: 1, minute: h(8) } });
  });

  it("sin horario ningún día: no vuelve a abrir", () => {
    expect(openStatus([], 4, h(10))).toEqual({ open: false, opensAt: null });
  });

  it("ignora rangos vacíos o al revés", () => {
    const week: DayHours[] = [{ weekday: 1, ranges: [{ start: h(10), end: h(10) }, { start: h(12), end: h(9) }] }];
    expect(openStatus(week, 1, h(10))).toEqual({ open: false, opensAt: null });
  });

  it("propiedad: abierto si y solo si algún rango de hoy contiene el minuto", () => {
    const range = fc
      .tuple(fc.integer({ min: 0, max: 1439 }), fc.integer({ min: 1, max: 600 }))
      .map(([start, len]) => ({ start, end: Math.min(1440, start + len) }));
    const day = fc.constantFrom<Weekday>(1, 2, 3, 4, 5, 6, 7);
    const week = fc.uniqueArray(fc.record({ weekday: day, ranges: fc.array(range, { maxLength: 3 }) }), {
      selector: (d) => d.weekday,
      maxLength: 7,
    });
    fc.assert(
      fc.property(week, day, fc.integer({ min: 0, max: 1439 }), (w, today, minute) => {
        const status = openStatus(w, today, minute);
        const todays = w.find((d) => d.weekday === today)?.ranges ?? [];
        const inside = todays.some((r) => r.start <= minute && minute < r.end);
        expect(status.open).toBe(inside);
        if (status.open) expect(status.closesAt).toBeGreaterThan(minute);
        if (!status.open && status.opensAt) {
          expect(status.opensAt.daysAhead).toBeGreaterThanOrEqual(0);
          expect(status.opensAt.daysAhead).toBeLessThanOrEqual(7);
          if (status.opensAt.daysAhead === 0) expect(status.opensAt.minute).toBeGreaterThan(minute);
        }
        // Si ningún día tiene horas, nunca abre.
        const anyHours = w.some((d) => d.ranges.some((r) => r.end > r.start));
        if (!anyHours) expect(status).toEqual({ open: false, opensAt: null });
      }),
    );
  });
});

describe("openStatusLabel", () => {
  it("textos para el cliente", () => {
    expect(openStatusLabel({ open: true, closesAt: h(21) })).toBe("Abierto ahora · cierra a las 9:00 p. m.");
    expect(openStatusLabel({ open: false, opensAt: { daysAhead: 0, weekday: 2, minute: h(13) } })).toBe("Cerrado · abre hoy a las 1:00 p. m.");
    expect(openStatusLabel({ open: false, opensAt: { daysAhead: 1, weekday: 3, minute: h(8) } })).toBe("Cerrado · abre mañana a las 8:00 a. m.");
    expect(openStatusLabel({ open: false, opensAt: { daysAhead: 2, weekday: 1, minute: h(8) } })).toBe("Cerrado · abre el lunes a las 8:00 a. m.");
    expect(openStatusLabel({ open: false, opensAt: null })).toBe("Cerrado por ahora");
  });
});
