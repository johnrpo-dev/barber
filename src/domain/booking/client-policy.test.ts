import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { activeLimitReached, clientCanCancel, clientCanReschedule, MAX_CLIENT_RESCHEDULES } from "./client-policy";
import { APPOINTMENT_STATUSES } from "./status";

const HOUR = 3_600_000;
const start = new Date("2026-11-10T20:00:00Z");
const before = (h: number) => new Date(start.getTime() - h * HOUR);

describe("lo que el cliente puede hacer con su cita", () => {
  it("cancela gratis fuera de la ventana y con aviso dentro de ella", () => {
    expect(clientCanCancel({ status: "confirmed", start }, before(5), 3)).toEqual({ ok: true, late: false });
    expect(clientCanCancel({ status: "pending", start }, before(1), 3)).toEqual({ ok: true, late: true });
  });

  it("no cancela después de la hora de inicio ni citas que ya no están activas", () => {
    expect(clientCanCancel({ status: "confirmed", start }, start, 3)).toEqual({ ok: false, reason: "started" });
    expect(clientCanCancel({ status: "cancelled", start }, before(24), 3)).toEqual({ ok: false, reason: "not_active" });
    expect(clientCanCancel({ status: "arrived", start }, before(1), 3)).toEqual({ ok: false, reason: "not_active" });
  });

  it("reprograma solo confirmadas, fuera de la ventana y hasta 2 veces", () => {
    expect(clientCanReschedule({ status: "confirmed", start }, before(5), 3, 0)).toEqual({ ok: true, late: false });
    expect(clientCanReschedule({ status: "pending", start }, before(5), 3, 0)).toEqual({ ok: false, reason: "not_confirmed" });
    expect(clientCanReschedule({ status: "confirmed", start }, before(2), 3, 0)).toEqual({ ok: false, reason: "late_window" });
    expect(clientCanReschedule({ status: "confirmed", start }, before(5), 3, MAX_CLIENT_RESCHEDULES)).toEqual({
      ok: false,
      reason: "too_many",
    });
    expect(clientCanReschedule({ status: "confirmed", start }, start, 0, 0)).toEqual({ ok: false, reason: "started" });
    expect(clientCanReschedule({ status: "no_show", start }, before(5), 3, 0)).toEqual({ ok: false, reason: "not_active" });
  });

  it("el tope de citas activas se alcanza al llegar al máximo", () => {
    expect(activeLimitReached(2, 3)).toBe(false);
    expect(activeLimitReached(3, 3)).toBe(true);
  });

  const scenario = fc.record({
    status: fc.constantFrom(...APPOINTMENT_STATUSES),
    offsetMin: fc.integer({ min: -3 * 24 * 60, max: 3 * 24 * 60 }),
    freeCancelHours: fc.integer({ min: 0, max: 48 }),
    reschedules: fc.integer({ min: 0, max: 5 }),
  });

  it("propiedad: después del inicio nunca se puede cancelar ni reprogramar", () => {
    fc.assert(
      fc.property(scenario, ({ status, offsetMin, freeCancelHours, reschedules }) => {
        const now = new Date(start.getTime() + Math.abs(offsetMin) * 60_000);
        expect(clientCanCancel({ status, start }, now, freeCancelHours).ok).toBe(false);
        expect(clientCanReschedule({ status, start }, now, freeCancelHours, reschedules).ok).toBe(false);
      }),
    );
  });

  it("propiedad: si se puede reprogramar, también se puede cancelar, y sin recargo", () => {
    fc.assert(
      fc.property(scenario, ({ status, offsetMin, freeCancelHours, reschedules }) => {
        const now = new Date(start.getTime() + offsetMin * 60_000);
        const r = clientCanReschedule({ status, start }, now, freeCancelHours, reschedules);
        if (!r.ok) return;
        expect(r.late).toBe(false);
        expect(reschedules).toBeLessThan(MAX_CLIENT_RESCHEDULES);
        expect(clientCanCancel({ status, start }, now, freeCancelHours)).toEqual({ ok: true, late: false });
      }),
    );
  });
});
