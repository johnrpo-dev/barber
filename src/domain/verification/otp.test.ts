import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyOtpAttempt,
  canResendOtp,
  generateOtp,
  hashOtp,
  normalizeOtpInput,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS,
  type OtpState,
  otpExpiry,
  otpMatches,
} from "./otp";

const PEPPER = "pepper-de-prueba-con-32-caracteres!";
const t0 = new Date("2026-11-02T15:00:00Z");
const fresh = (): OtpState => ({
  attempts: 0,
  maxAttempts: OTP_MAX_ATTEMPTS,
  expiresAt: new Date(t0.getTime() + 5 * 60_000),
  consumedAt: null,
  supersededAt: null,
});

describe("código de verificación", () => {
  it("siempre tiene 6 dígitos, incluso cuando el azar da un número corto", () => {
    expect(generateOtp(() => 42)).toBe("000042");
    fc.assert(fc.property(fc.integer({ min: 0, max: 999_999 }), (n) => /^\d{6}$/.test(generateOtp(() => n))));
  });

  it("el hash depende de la verificación: el mismo código en otra no sirve", () => {
    const hash = hashOtp(PEPPER, 1n, "123456");
    expect(otpMatches(PEPPER, 1n, "123456", hash)).toBe(true);
    expect(otpMatches(PEPPER, 2n, "123456", hash)).toBe(false);
    expect(otpMatches(PEPPER, 1n, "123457", hash)).toBe(false);
    expect(otpMatches("otro-pepper-de-prueba-de-32-chars", 1n, "123456", hash)).toBe(false);
  });

  it("acepta lo que pega la gente, pero solo 6 dígitos", () => {
    expect(normalizeOtpInput(" 123 456 ")).toBe("123456");
    expect(normalizeOtpInput("123-456")).toBe("123456");
    expect(normalizeOtpInput("12345")).toBeNull();
    expect(normalizeOtpInput("1234567")).toBeNull();
  });

  it("vence a los 5 minutos o con la retención, lo que llegue primero", () => {
    expect(otpExpiry(t0, new Date(t0.getTime() + 10 * 60_000))).toEqual(new Date(t0.getTime() + 5 * 60_000));
    expect(otpExpiry(t0, new Date(t0.getTime() + 2 * 60_000))).toEqual(new Date(t0.getTime() + 2 * 60_000));
  });

  it("propiedad: se consume a lo sumo una vez, solo con el código correcto, sin vencer y sin pasar de los intentos", () => {
    const attempt = fc.record({ matches: fc.boolean(), afterSec: fc.integer({ min: 0, max: 600 }) });
    fc.assert(
      fc.property(fc.array(attempt, { maxLength: 15 }), (attempts) => {
        let state = fresh();
        let verified = 0;
        for (const a of [...attempts].sort((x, y) => x.afterSec - y.afterSec)) {
          const now = new Date(t0.getTime() + a.afterSec * 1000);
          const before = state;
          const r = applyOtpAttempt(state, a.matches, now);
          state = r.state;
          expect(state.attempts).toBeLessThanOrEqual(state.maxAttempts);
          if (r.outcome === "verified") {
            verified++;
            expect(a.matches).toBe(true);
            expect(now.getTime()).toBeLessThan(before.expiresAt.getTime());
            expect(before.attempts).toBeLessThan(before.maxAttempts);
          }
          // Un intento rechazado por estado no cambia nada.
          if (["used", "superseded", "expired", "locked"].includes(r.outcome)) expect(state).toBe(before);
        }
        expect(verified).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("el intento cuenta aunque falle: 5 errores bloquean incluso el código correcto", () => {
    let state = fresh();
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) state = applyOtpAttempt(state, false, t0).state;
    expect(applyOtpAttempt(state, true, t0).outcome).toBe("locked");
  });

  it("un código reemplazado por un reenvío ya no sirve", () => {
    expect(applyOtpAttempt({ ...fresh(), supersededAt: t0 }, true, t0).outcome).toBe("superseded");
  });

  it("reenvío: espera de 60 s y máximo 3 envíos", () => {
    expect(canResendOtp({ sendCount: 1, lastSentAt: t0 }, new Date(t0.getTime() + 20_000))).toEqual({
      ok: false,
      reason: "cooldown",
      waitSec: 40,
    });
    expect(canResendOtp({ sendCount: 1, lastSentAt: t0 }, new Date(t0.getTime() + 60_000))).toEqual({ ok: true });
    expect(canResendOtp({ sendCount: OTP_MAX_SENDS, lastSentAt: t0 }, new Date(t0.getTime() + 3_600_000))).toEqual({
      ok: false,
      reason: "limit",
    });
  });
});
