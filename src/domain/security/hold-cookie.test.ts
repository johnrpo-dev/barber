import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { newHoldId, readHoldCookie, signHoldId } from "./hold-cookie";

const SECRET = "p".repeat(32); // valor de prueba
const OTHER = "q".repeat(32);

describe("cookie villa_hold firmada", () => {
  it("lo firmado se lee; con otra llave, no", () => {
    const id = newHoldId();
    const value = signHoldId(SECRET, id);
    expect(readHoldCookie(SECRET, value)).toBe(id);
    expect(readHoldCookie(OTHER, value)).toBeNull();
  });

  it("rechaza la cookie vieja sin firma, vacíos y basura", () => {
    for (const v of [undefined, null, "", "x".repeat(43), `${"x".repeat(43)}.`, `.${"x".repeat(43)}`, "a.b.c", "x".repeat(200)]) {
      expect(readHoldCookie(SECRET, v)).toBeNull();
    }
  });

  it("propiedad: cambiar cualquier carácter del valor firmado lo invalida", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    fc.assert(
      fc.property(fc.nat(), fc.nat(), (pos, pick) => {
        const id = newHoldId();
        const value = signHoldId(SECRET, id);
        const i = pos % value.length;
        if (value[i] === ".") return true;
        const replacement = alphabet[pick % alphabet.length]!;
        if (replacement === value[i]) return true;
        const tampered = value.slice(0, i) + replacement + value.slice(i + 1);
        return readHoldCookie(SECRET, tampered) === null;
      }),
      { numRuns: 300 },
    );
  });

  it("propiedad: dos identificadores nuevos nunca se repiten y siempre se pueden firmar", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const a = newHoldId();
        const b = newHoldId();
        return a !== b && readHoldCookie(SECRET, signHoldId(SECRET, a)) === a;
      }),
      { numRuns: 100 },
    );
  });
});
