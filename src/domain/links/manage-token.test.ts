import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveManageToken, hashManageToken, isManageTokenShape, MANAGE_LINK_GRACE_DAYS, manageLinkExpiry } from "./manage-token";

const SECRET = "secreto-de-enlaces-con-32-caracteres!";
const ULID = "01JBZ6Q4T3V8W9X0Y1Z2A3B4C5";

describe("enlace de gestión", () => {
  it("el token es estable y tiene forma de token", () => {
    const token = deriveManageToken(SECRET, ULID, 0);
    expect(token).toHaveLength(43);
    expect(isManageTokenShape(token)).toBe(true);
    expect(deriveManageToken(SECRET, ULID, 0)).toBe(token);
  });

  it("rotar la generación o cambiar el secreto da otro token", () => {
    const token = deriveManageToken(SECRET, ULID, 0);
    expect(deriveManageToken(SECRET, ULID, 1)).not.toBe(token);
    expect(deriveManageToken("otro-secreto-de-enlaces-de-32-chars", ULID, 0)).not.toBe(token);
    expect(() => deriveManageToken(SECRET, ULID, -1)).toThrow(RangeError);
    expect(() => deriveManageToken(SECRET, ULID, 1.5)).toThrow(RangeError);
  });

  it("descarta lo que no tiene forma de token sin ir a la base", () => {
    expect(isManageTokenShape("")).toBe(false);
    expect(isManageTokenShape("a".repeat(42))).toBe(false);
    expect(isManageTokenShape("a".repeat(44))).toBe(false);
    expect(isManageTokenShape(`${"a".repeat(42)}=`)).toBe(false);
    expect(isManageTokenShape(`${"a".repeat(42)}/`)).toBe(false);
  });

  it("vence 7 días después del fin de la cita", () => {
    const end = new Date("2026-11-10T21:00:00Z");
    expect(MANAGE_LINK_GRACE_DAYS).toBe(7);
    expect(manageLinkExpiry(end)).toEqual(new Date("2026-11-17T21:00:00Z"));
  });

  it("propiedad: determinista, con forma válida, hash de 32 bytes y distinto por cita o generación", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), fc.nat({ max: 1000 }), fc.nat({ max: 1000 }), (a, b, g1, g2) => {
        const t = deriveManageToken(SECRET, a, g1);
        expect(deriveManageToken(SECRET, a, g1)).toBe(t);
        expect(isManageTokenShape(t)).toBe(true);
        expect(hashManageToken(t)).toHaveLength(32);
        if (a !== b) expect(deriveManageToken(SECRET, b, g1)).not.toBe(t);
        if (g1 !== g2) expect(deriveManageToken(SECRET, a, g2)).not.toBe(t);
      }),
    );
  });
});
