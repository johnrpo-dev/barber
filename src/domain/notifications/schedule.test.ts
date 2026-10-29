import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { dedupeKey, dueReminders, REMINDER_DEDUPE } from "./schedule";

const MIN = 60_000;
const start = new Date("2026-11-10T20:00:00Z");
const left = (min: number) => new Date(start.getTime() - min * MIN);

describe("recordatorios", () => {
  it("24 h: entre 24 h y 3 h antes", () => {
    expect(dueReminders(left(24 * 60), start)).toEqual(["reminder_24h"]);
    expect(dueReminders(left(24 * 60 + 1), start)).toEqual([]);
    expect(dueReminders(left(3 * 60 + 1), start)).toEqual(["reminder_24h"]);
    expect(dueReminders(left(3 * 60), start)).toEqual([]);
  });

  it("2 h: entre 2 h y 30 min antes; nunca más cerca", () => {
    expect(dueReminders(left(120), start)).toEqual(["reminder_2h"]);
    expect(dueReminders(left(31), start)).toEqual(["reminder_2h"]);
    expect(dueReminders(left(30), start)).toEqual([]);
    expect(dueReminders(start, start)).toEqual([]);
    expect(dueReminders(left(150), start)).toEqual([]);
  });

  it("claves de deduplicación con el formato del outbox", () => {
    expect(dedupeKey("confirm", "01JBZ")).toBe("confirm:01JBZ");
    expect(dedupeKey("cancel", "01JBZ", start)).toBe("cancel:01JBZ");
    expect(dedupeKey("rem24", "01JBZ", start)).toBe("rem24:01JBZ:2026-11-10T20:00:00.000Z");
    expect(dedupeKey(REMINDER_DEDUPE.reminder_2h, "01JBZ", start)).toBe("rem2:01JBZ:2026-11-10T20:00:00.000Z");
    expect(dedupeKey("resched", "01JBZ", start)).toBe("resched:01JBZ:2026-11-10T20:00:00.000Z");
    expect(() => dedupeKey("rem2", "01JBZ")).toThrow();
  });

  it("reprogramar cambia la clave del recordatorio", () => {
    expect(dedupeKey("rem24", "01JBZ", start)).not.toBe(dedupeKey("rem24", "01JBZ", new Date(start.getTime() + 30 * MIN)));
  });

  it("propiedad: a lo sumo un recordatorio a la vez, y nunca a 30 min o menos de la cita", () => {
    fc.assert(
      fc.property(fc.integer({ min: -3 * 24 * 3600, max: 3 * 24 * 3600 }), (sec) => {
        const now = new Date(start.getTime() - sec * 1000);
        const due = dueReminders(now, start);
        expect(due.length).toBeLessThanOrEqual(1);
        if (start.getTime() <= now.getTime() + 30 * MIN) expect(due).toEqual([]);
      }),
    );
  });

  it("propiedad: con un scan por minuto, los dos recordatorios se detectan y cada uno con una sola clave", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 59 }), (phaseSec) => {
        const seen = new Map<string, number>(); // el scan ve la misma clave muchas veces; el outbox guarda una fila
        for (let m = 26 * 60; m >= 0; m--) {
          const now = new Date(start.getTime() - m * MIN + phaseSec * 1000);
          for (const kind of dueReminders(now, start)) {
            const key = dedupeKey(REMINDER_DEDUPE[kind], "01JBZ", start);
            seen.set(key, (seen.get(key) ?? 0) + 1);
          }
        }
        expect([...seen.keys()].sort()).toEqual(["rem24:01JBZ:2026-11-10T20:00:00.000Z", "rem2:01JBZ:2026-11-10T20:00:00.000Z"]);
      }),
      { numRuns: 20 },
    );
  });
});
