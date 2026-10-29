import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isAllowed, policiesFor, RATE_POLICIES, type RatePolicy, rateBucket, windowStart } from "./rate-limit";

const t0 = new Date("2026-11-02T15:20:00Z");

describe("límites de uso", () => {
  it("la tabla coincide con la decisión del arquitecto", () => {
    expect(policiesFor("booking_start", "ip")).toEqual([
      { windowSec: 3600, limit: 10 },
      { windowSec: 86_400, limit: 30 },
    ]);
    expect(policiesFor("booking_start", "contact")).toEqual([{ windowSec: 3600, limit: 5 }]);
    expect(policiesFor("otp_send", "contact")).toEqual([{ windowSec: 86_400, limit: 6 }]);
    expect(RATE_POLICIES.otp_verify.ip).toEqual([{ windowSec: 3600, limit: 30 }]);
    expect(policiesFor("manage_action", "contact")).toEqual([]);
  });

  it("la ventana fija se alinea a la época, en UTC", () => {
    expect(windowStart(t0, 3600)).toEqual(new Date("2026-11-02T15:00:00Z"));
    expect(windowStart(t0, 86_400)).toEqual(new Date("2026-11-02T00:00:00Z"));
    expect(windowStart(new Date("2026-11-02T15:00:00Z"), 3600)).toEqual(new Date("2026-11-02T15:00:00Z"));
    expect(() => windowStart(t0, 0)).toThrow(RangeError);
  });

  it("la cubeta nombra acción, alcance, ventana y sujeto", () => {
    expect(rateBucket("booking_start", "ip", "abc123", { windowSec: 3600, limit: 10 })).toBe("booking_start:ip:3600:abc123");
  });

  it("el golpe número `limit` pasa; el siguiente no", () => {
    const p = { windowSec: 3600, limit: 5 };
    expect(isAllowed(5, p)).toBe(true);
    expect(isAllowed(6, p)).toBe(false);
  });

  it("propiedad: la ventana contiene a `now`", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), fc.constantFrom(60, 3600, 86_400), (ms, w) => {
        const now = new Date(ms);
        const start = windowStart(now, w).getTime();
        return start <= ms && ms < start + w * 1000;
      }),
    );
  });

  it("propiedad: con un contador por ventana, nunca pasan más de `limit` solicitudes por ventana", () => {
    const policy = fc.record({ windowSec: fc.constantFrom(60, 3600), limit: fc.integer({ min: 1, max: 12 }) });
    fc.assert(
      fc.property(policy, fc.array(fc.integer({ min: 0, max: 4 * 3600 * 1000 }), { maxLength: 200 }), (p: RatePolicy, offsets) => {
        const counters = new Map<number, number>();
        const allowed = new Map<number, number>();
        const sent = new Map<number, number>();
        for (const off of [...offsets].sort((a, b) => a - b)) {
          const w = windowStart(new Date(t0.getTime() + off), p.windowSec).getTime();
          const hits = (counters.get(w) ?? 0) + 1;
          counters.set(w, hits);
          sent.set(w, (sent.get(w) ?? 0) + 1);
          if (isAllowed(hits, p)) allowed.set(w, (allowed.get(w) ?? 0) + 1);
        }
        for (const [w, n] of sent) expect(allowed.get(w) ?? 0).toBe(Math.min(n, p.limit));
      }),
    );
  });
});
