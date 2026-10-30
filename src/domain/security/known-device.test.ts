import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isKnownDevice, KNOWN_DEVICE_MAX_AGE_S, MAX_ENTRIES, withKnownDevice } from "./known-device";

const SECRET = "k".repeat(32);
const NOW = new Date("2026-11-02T15:00:00Z");
const email = fc.emailAddress();

describe("dispositivo conocido", () => {
  it("marca el correo con el que se ingresó, y solo ese, por 90 días", () => {
    const value = withKnownDevice(SECRET, null, "Dueno@Villa.co", NOW);
    expect(isKnownDevice(SECRET, value, " dueno@villa.co ", NOW)).toBe(true);
    expect(isKnownDevice(SECRET, value, "otra@villa.co", NOW)).toBe(false);
    expect(isKnownDevice("x".repeat(32), value, "dueno@villa.co", NOW)).toBe(false);
    const later = new Date(NOW.getTime() + KNOWN_DEVICE_MAX_AGE_S * 1000);
    expect(isKnownDevice(SECRET, value, "dueno@villa.co", later)).toBe(false);
    expect(value).not.toContain("dueno");
  });

  it("propiedad: una cookie alterada o inventada nunca vale", () => {
    fc.assert(
      fc.property(email, fc.string({ maxLength: 120 }), (e, junk) => {
        expect(isKnownDevice(SECRET, junk, e, NOW)).toBe(false);
        const real = withKnownDevice(SECRET, null, e, NOW);
        const tampered = real.replace(/\.(.)/, (_, c: string) => `.${c === "A" ? "B" : "A"}`);
        expect(isKnownDevice(SECRET, tampered, e, NOW)).toBe(false);
      }),
    );
  });

  it("propiedad: un navegador compartido recuerda a los últimos, sin pasar del tope", () => {
    fc.assert(
      fc.property(fc.uniqueArray(email, { minLength: 1, maxLength: 9, selector: (e) => e.toLowerCase() }), (emails) => {
        let value: string | null = null;
        for (const e of emails) value = withKnownDevice(SECRET, value, e, NOW);
        expect(value!.split("~").length).toBe(Math.min(emails.length, MAX_ENTRIES));
        for (const e of emails.slice(-MAX_ENTRIES)) expect(isKnownDevice(SECRET, value, e, NOW)).toBe(true);
      }),
    );
  });
});
