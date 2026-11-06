import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertValidClientName, formatPhone, InvalidClientError, maskEmail, maskPhone, normalizePhone } from "./client";

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
  it("enmascara el correo: primer carácter del usuario y el dominio", () => {
    expect(maskEmail("juan.perez@gmail.com")).toBe("j•••@gmail.com");
    expect(maskEmail("a@b.co")).toBe("a•••@b.co");
    expect(maskEmail("ñandú@correo.com.co")).toBe("ñ•••@correo.com.co");
    expect(maskEmail("sin-arroba")).toBe("•••");
    expect(maskEmail("@dominio.com")).toBe("•••");
  });

  it("enmascara el celular de otro país dejando solo los dos últimos dígitos", () => {
    expect(maskPhone("+14155550100")).toBe("••••00");
  });

  it("propiedad: maskEmail nunca revela más que el primer carácter del usuario y el dominio", () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        const at = email.lastIndexOf("@");
        const user = email.slice(0, at);
        const domain = email.slice(at + 1);
        const masked = maskEmail(email);
        expect(masked).toBe(`${[...user][0]}•••@${domain}`);
        // Del usuario solo sobrevive el primer carácter: el resto no aparece en lo enmascarado.
        if ([...user].length > 1) expect(masked.startsWith(user)).toBe(false);
      }),
    );
  });

  it("propiedad: maskPhone solo revela los primeros 3 y los últimos 2 dígitos nacionales", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^3\d{9}$/), (cel) => {
        const masked = maskPhone(`+57${cel}`);
        expect(masked.replace(/\D/g, "")).toBe(cel.slice(0, 3) + cel.slice(-2));
        expect(masked.startsWith(cel.slice(0, 3))).toBe(true);
        expect(masked.endsWith(cel.slice(-2))).toBe(true);
      }),
    );
    // Cualquier E.164 (de otro país incluido): nunca más de 5 dígitos visibles, nunca el número entero.
    fc.assert(
      fc.property(fc.stringMatching(/^\+[1-9]\d{7,14}$/), (e164) => {
        const shown = maskPhone(e164).replace(/\D/g, "");
        expect(shown.length).toBeLessThanOrEqual(5);
        expect(shown.endsWith(e164.slice(-2))).toBe(true);
      }),
    );
  });
});
