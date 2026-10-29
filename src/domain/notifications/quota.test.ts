import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPS, type QuotaState, quotaState } from "./quota";

const RANK: Record<QuotaState, number> = { ok: 0, warn: 1, blocked: 2 };

describe("cuotas de envío", () => {
  it("6 por destinatario y 300 globales al día", () => {
    expect(DEFAULT_CAPS).toEqual({ perRecipientPerDay: 6, globalPerDay: 300 });
  });

  it("avisa desde el 80 % y bloquea al llegar al tope", () => {
    expect(quotaState(239, 300)).toBe("ok");
    expect(quotaState(240, 300)).toBe("warn");
    expect(quotaState(299, 300)).toBe("warn");
    expect(quotaState(300, 300)).toBe("blocked");
    expect(quotaState(4, 6)).toBe("ok");
    expect(quotaState(5, 6)).toBe("warn");
    expect(quotaState(6, 6)).toBe("blocked");
    expect(quotaState(0, 0)).toBe("blocked");
  });

  it("propiedad: nunca baja al enviar más, y con el tope ya alcanzado siempre bloquea", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1000 }), fc.nat({ max: 1000 }), fc.integer({ min: 0, max: 1000 }), (a, b, cap) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(RANK[quotaState(lo, cap)]).toBeLessThanOrEqual(RANK[quotaState(hi, cap)]);
        expect(quotaState(hi, cap) === "blocked").toBe(hi >= cap);
      }),
    );
  });

  it("propiedad: enviando solo mientras no está bloqueado, nunca se pasa del tope", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), fc.nat({ max: 200 }), (cap, tries) => {
        let sent = 0;
        for (let i = 0; i < tries; i++) if (quotaState(sent, cap) !== "blocked") sent++;
        expect(sent).toBe(Math.min(tries, cap));
      }),
    );
  });
});
