import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { dedupeKey, dueReminders, REMINDER_DEDUPE } from "./schedule";

const MIN = 60_000;
const HOUR = 60 * MIN;
const start = new Date("2026-11-10T20:00:00Z");
const left = (min: number) => new Date(start.getTime() - min * MIN);
/** Reservada con un día de anticipación. */
const early = new Date(start.getTime() - 24 * HOUR);

describe("recordatorio único", () => {
  it("entre 3 h y 30 min antes; nunca más cerca ni más lejos", () => {
    expect(dueReminders(left(180), start, early)).toEqual(["reminder_same_day"]);
    expect(dueReminders(left(181), start, early)).toEqual([]);
    expect(dueReminders(left(31), start, early)).toEqual(["reminder_same_day"]);
    expect(dueReminders(left(30), start, early)).toEqual([]);
    expect(dueReminders(start, start, early)).toEqual([]);
    expect(dueReminders(left(24 * 60), start, early)).toEqual([]);
  });

  it("solo si la hora se apartó con más de 6 h de anticipación", () => {
    const at = (hoursBefore: number) => new Date(start.getTime() - hoursBefore * HOUR);
    expect(dueReminders(left(120), start, at(6))).toEqual([]);
    expect(dueReminders(left(120), start, new Date(at(6).getTime() - 1))).toEqual(["reminder_same_day"]);
    expect(dueReminders(left(120), start, at(4))).toEqual([]);
    // Reprogramada hace un rato para dentro de 2 h: la última hora fijada manda.
    expect(dueReminders(left(120), start, left(125))).toEqual([]);
  });

  it("claves de deduplicación con el formato del outbox", () => {
    expect(dedupeKey("confirm", "01JBZ")).toBe("confirm:01JBZ");
    expect(dedupeKey("cancel", "01JBZ", start)).toBe("cancel:01JBZ");
    expect(dedupeKey(REMINDER_DEDUPE.reminder_same_day, "01JBZ", start)).toBe("rem:01JBZ:2026-11-10T20:00:00.000Z");
    expect(dedupeKey("resched", "01JBZ", start)).toBe("resched:01JBZ:2026-11-10T20:00:00.000Z");
    expect(() => dedupeKey("rem", "01JBZ")).toThrow();
  });

  it("reprogramar cambia la clave del recordatorio", () => {
    expect(dedupeKey("rem", "01JBZ", start)).not.toBe(dedupeKey("rem", "01JBZ", new Date(start.getTime() + 30 * MIN)));
  });

  it("propiedad: a lo sumo uno, nunca a 30 min o menos ni a más de 3 h, y nunca si se apartó con 6 h o menos", () => {
    fc.assert(
      fc.property(fc.integer({ min: -3 * 24 * 3600, max: 3 * 24 * 3600 }), fc.integer({ min: 0, max: 7 * 24 * 3600 }), (sec, leadSec) => {
        const now = new Date(start.getTime() - sec * 1000);
        const scheduledAt = new Date(start.getTime() - leadSec * 1000);
        const due = dueReminders(now, start, scheduledAt);
        expect(due.length).toBeLessThanOrEqual(1);
        const leftMs = start.getTime() - now.getTime();
        if (leftMs <= 30 * MIN || leftMs > 3 * HOUR) expect(due).toEqual([]);
        if (leadSec * 1000 <= 6 * HOUR) expect(due).toEqual([]);
      }),
    );
  });

  it("propiedad: con un scan por minuto, una reserva anticipada genera exactamente una clave", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 59 }), fc.integer({ min: 6 * 60 + 1, max: 7 * 24 * 60 }), (phaseSec, leadMin) => {
        const scheduledAt = new Date(start.getTime() - leadMin * MIN);
        const seen = new Set<string>(); // el scan ve la misma clave muchas veces; el outbox guarda una fila
        for (let m = 26 * 60; m >= 0; m--) {
          const now = new Date(start.getTime() - m * MIN + phaseSec * 1000);
          for (const kind of dueReminders(now, start, scheduledAt)) seen.add(dedupeKey(REMINDER_DEDUPE[kind], "01JBZ", start));
        }
        expect([...seen]).toEqual(["rem:01JBZ:2026-11-10T20:00:00.000Z"]);
      }),
      { numRuns: 20 },
    );
  });
});
