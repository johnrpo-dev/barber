import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_S, sessionPastMaxAge } from "./reauth";

describe("vida máxima absoluta de la sesión", () => {
  it("es de 12 horas", () => {
    expect(SESSION_MAX_AGE_S).toBe(12 * 60 * 60);
  });

  it("propiedad: vence exactamente al cumplir la vida máxima, sin importar el uso", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_000_000_000_000 }), fc.integer({ min: -60_000, max: 3 * SESSION_MAX_AGE_S * 1000 }), (created, age) => {
        const createdAt = new Date(created);
        const now = new Date(created + age);
        expect(sessionPastMaxAge(createdAt, now)).toBe(age >= SESSION_MAX_AGE_S * 1000);
      }),
    );
  });

  it("sin fecha de creación decide better-auth", () => {
    expect(sessionPastMaxAge(null, new Date())).toBe(false);
  });
});
