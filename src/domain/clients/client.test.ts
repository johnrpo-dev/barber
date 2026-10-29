import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertValidClientName, formatPhone, InvalidClientError, maskPhone, normalizePhone } from "./client";

describe("clientes", () => {
  it.each([
    ["300 123 4567", "+573001234567"],
    ["(300) 123-4567", "+573001234567"],
    ["57 300 123 4567", "+573001234567"],
    ["+57 300 123 4567", "+573001234567"],
    ["+1 415 555 0100", "+14155550100"],
  ])("normaliza %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["123", "601 234 5678", "+57 601 234 5678", "abc"])("rechaza %s", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("muestra el número completo solo con permiso; si no, enmascarado", () => {
    expect(formatPhone("+573001234567")).toBe("300 123 4567");
    expect(maskPhone("+573001234567")).toBe("300 ••• ••67");
  });

  it("limpia espacios del nombre y exige un largo razonable", () => {
    expect(assertValidClientName("  Juan   Pérez ")).toBe("Juan Pérez");
    expect(() => assertValidClientName("J")).toThrow(InvalidClientError);
  });

  it("propiedad: cualquier forma de escribir un celular colombiano da el mismo E.164", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^3\d{9}$/), fc.constantFrom(" ", "-", ""), fc.boolean(), (cel, sep, prefix) => {
        const written = `${prefix ? "+57 " : ""}${cel.slice(0, 3)}${sep}${cel.slice(3, 6)}${sep}${cel.slice(6)}`;
        expect(normalizePhone(written)).toBe(`+57${cel}`);
      }),
    );
  });
});
