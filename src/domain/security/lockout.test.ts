import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { failuresExpired, LOCKOUT_POLICY, lockDurationMs, lockedMessage, minutesLeft } from "./lockout";
import { isRecentAuth, lastAuthAt, REAUTH_WINDOW_MS } from "./reauth";

const policy = fc
  .record({
    threshold: fc.integer({ min: 1, max: 20 }),
    baseMs: fc.integer({ min: 1_000, max: 10 * 60_000 }),
    extra: fc.integer({ min: 0, max: 60 * 60_000 }),
    resetAfterMs: fc.integer({ min: 60_000, max: 7 * 86_400_000 }),
  })
  .map(({ extra, ...p }) => ({ ...p, maxMs: p.baseMs + extra }));
const failures = fc.integer({ min: 0, max: 10_000 });

describe("bloqueo por cuenta", () => {
  it("la política acordada: 5 fallos, desde 1 minuto hasta 15", () => {
    expect([4, 5, 6, 7, 8, 9, 10, 50].map((n) => lockDurationMs(n) / 60_000)).toEqual([0, 1, 2, 4, 8, 15, 15, 15]);
  });

  it("no bloquea por debajo del umbral y siempre bloquea desde el umbral", () => {
    fc.assert(
      fc.property(policy, failures, (p, n) => {
        const ms = lockDurationMs(n, p);
        if (n < p.threshold) expect(ms).toBe(0);
        else expect(ms).toBeGreaterThanOrEqual(Math.min(p.baseMs, p.maxMs));
      }),
    );
  });

  it("nunca pasa del tope y nunca baja con un fallo más", () => {
    fc.assert(
      fc.property(policy, failures, (p, n) => {
        const ms = lockDurationMs(n, p);
        expect(ms).toBeLessThanOrEqual(p.maxMs);
        expect(lockDurationMs(n + 1, p)).toBeGreaterThanOrEqual(ms);
      }),
    );
  });

  it("cada fallo después del umbral duplica la espera hasta el tope", () => {
    fc.assert(
      fc.property(policy, fc.integer({ min: 0, max: 40 }), (p, k) => {
        const n = p.threshold + k;
        expect(lockDurationMs(n + 1, p)).toBe(Math.min(lockDurationMs(n, p) * 2, p.maxMs));
      }),
    );
  });

  it("el contador se reinicia tras el tiempo de calma", () => {
    const t = new Date("2026-11-02T15:00:00Z");
    expect(failuresExpired(t, new Date(t.getTime() + LOCKOUT_POLICY.resetAfterMs - 1))).toBe(false);
    expect(failuresExpired(t, new Date(t.getTime() + LOCKOUT_POLICY.resetAfterMs))).toBe(true);
  });

  it("el mensaje es genérico y dice cuánto esperar", () => {
    const now = new Date("2026-11-02T15:00:00Z");
    expect(lockedMessage(new Date(now.getTime() + 30_000), now)).toBe("Demasiados intentos. Espera 1 minuto y vuelve a intentar.");
    expect(lockedMessage(new Date(now.getTime() + 4 * 60_000 + 1), now)).toBe("Demasiados intentos. Espera 5 minutos y vuelve a intentar.");
    fc.assert(
      fc.property(fc.integer({ min: -60_000, max: 86_400_000 }), (ms) => {
        expect(minutesLeft(new Date(now.getTime() + ms), now)).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  it("rechaza conteos inválidos", () => {
    expect(() => lockDurationMs(-1)).toThrow(RangeError);
    expect(() => lockDurationMs(1.5)).toThrow(RangeError);
  });
});

describe("reautenticación", () => {
  const now = new Date("2026-11-02T15:00:00Z");

  it("vale dentro de la ventana de 5 minutos y no después", () => {
    expect(isRecentAuth(new Date(now.getTime() - REAUTH_WINDOW_MS + 1), now)).toBe(true);
    expect(isRecentAuth(new Date(now.getTime() - REAUTH_WINDOW_MS), now)).toBe(false);
    expect(isRecentAuth(null, now)).toBe(false);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 86_400_000 }), (age) => {
        expect(isRecentAuth(new Date(now.getTime() - age), now)).toBe(age < REAUTH_WINDOW_MS);
      }),
    );
  });

  it("toma la prueba más reciente entre el ingreso y la reautenticación", () => {
    fc.assert(
      fc.property(fc.option(fc.date({ noInvalidDate: true })), fc.option(fc.date({ noInvalidDate: true })), (a, b) => {
        const at = lastAuthAt(a, b);
        const all = [a, b].filter((d): d is Date => d !== null);
        if (all.length === 0) expect(at).toBeNull();
        else expect(at!.getTime()).toBe(Math.max(...all.map((d) => d.getTime())));
      }),
    );
  });
});
