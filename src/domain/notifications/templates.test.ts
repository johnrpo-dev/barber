import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  firstNameForMessage,
  NOTIFICATION_TEMPLATES,
  type NotificationTemplate,
  renderEmail,
  TEMPLATE_PARAMS,
  WHATSAPP_TEMPLATE_NAMES,
} from "./templates";

const SAMPLE: Record<string, string> = {
  code: "042917",
  name: "Andrés",
  service: "Corte clásico",
  staff: "Juan",
  date: "martes 10 de noviembre",
  time: "3:00 p. m.",
  ticket: "V-0427",
  url: "https://villa.test/cita/abc",
  address: "Calle 10 # 5-20",
};

const paramsFor = (t: NotificationTemplate, over: Record<string, string> = {}) =>
  Object.fromEntries(TEMPLATE_PARAMS[t].map((k) => [k, over[k] ?? SAMPLE[k]!]));

describe("primer nombre para mensajes", () => {
  it("toma la primera palabra, solo letras, con tildes y ñ", () => {
    expect(firstNameForMessage("  María José  Pérez")).toBe("María");
    expect(firstNameForMessage("Íñigo")).toBe("Íñigo");
    expect(firstNameForMessage("<script>alert(1)</script>")).toBe("scriptalertscript");
    expect(firstNameForMessage("Llama al 3001234567")).toBe("Llama");
    expect(firstNameForMessage("12345 ...")).toBe("");
    expect(firstNameForMessage("   ")).toBe("");
    expect(firstNameForMessage("a".repeat(50))).toHaveLength(30);
  });

  it("propiedad: siempre solo letras y como mucho 30", () => {
    fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 80 }), (s) => /^\p{L}{0,30}$/u.test(firstNameForMessage(s))));
  });
});

describe("plantillas", () => {
  it("cada plantilla tiene su nombre en Meta y sus parámetros", () => {
    for (const t of NOTIFICATION_TEMPLATES) {
      expect(WHATSAPP_TEMPLATE_NAMES[t]).toMatch(/^villa_[a-z0-9_]+$/);
      expect(TEMPLATE_PARAMS[t].length).toBeGreaterThan(0);
    }
    expect(new Set(Object.values(WHATSAPP_TEMPLATE_NAMES)).size).toBe(NOTIFICATION_TEMPLATES.length);
  });

  it("los asuntos siguen el texto del diseño", () => {
    expect(renderEmail("otp", paramsFor("otp")).subject).toBe("Tu código de Villa: 042917");
    expect(renderEmail("booking_confirmed", paramsFor("booking_confirmed")).subject).toBe("Cita confirmada: martes 10 de noviembre a las 3:00 p. m.");
    expect(renderEmail("reminder_24h", paramsFor("reminder_24h")).subject).toBe("Mañana a las 3:00 p. m.: tu turno en Villa");
    expect(renderEmail("reminder_2h", paramsFor("reminder_2h")).subject).toBe("Hoy a las 3:00 p. m.: te esperamos");
    expect(renderEmail("appointment_cancelled_staff", paramsFor("appointment_cancelled_staff")).subject).toBe(
      "Cancelamos tu cita del martes 10 de noviembre",
    );
  });

  it("la confirmación lleva el ticket como tabla y el botón a la cita", () => {
    const m = renderEmail("booking_confirmed", paramsFor("booking_confirmed"));
    expect(m.text).toContain("¡Listo, Andrés! Tu cita en Villa quedó confirmada: Corte clásico con Juan");
    expect(m.text).toContain("Código de turno: V-0427");
    expect(m.html).toContain("<table");
    expect(m.html).toContain('href="https://villa.test/cita/abc"');
  });

  it("el código nunca lleva el nombre, aunque llegue en los parámetros", () => {
    const m = renderEmail("otp", { code: "123456", name: "Atacante dice: llama al 300" });
    for (const part of [m.subject, m.text, m.html]) expect(part).not.toContain("Atacante");
    expect(m.text).toContain("123456 es tu código de verificación");
  });

  it("falta un parámetro, enlace raro o salto de línea: no se envía nada raro", () => {
    expect(() => renderEmail("reminder_2h", { name: "Ana", time: "3:00 p. m.", url: "https://villa.test/c" })).toThrow(/address/);
    expect(() => renderEmail("reminder_2h", paramsFor("reminder_2h", { url: "javascript:alert(1)" }))).toThrow(/http/);
    expect(renderEmail("otp", { code: "123456\r\nBcc: x@y.co" }).subject).toBe("Tu código de Villa: 123456 Bcc: x@y.co");
  });

  it("propiedad: todo parámetro declarado aparece en el texto y el HTML lo escapa", () => {
    const value = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /\S/.test(s) && !/[\u0000-\u001f\u007f]/.test(s) && s.trim() === s);
    fc.assert(
      fc.property(fc.constantFrom(...NOTIFICATION_TEMPLATES), value, (t, v) => {
        const params = paramsFor(t, Object.fromEntries(TEMPLATE_PARAMS[t].map((k) => [k, k === "url" ? `https://villa.test/${v.replace(/\s/g, "")}x` : v])));
        const baseline = renderEmail(t, paramsFor(t, Object.fromEntries(TEMPLATE_PARAMS[t].map((k) => [k, k === "url" ? "https://villa.test/x" : "x"]))));
        const m = renderEmail(t, params);
        for (const k of TEMPLATE_PARAMS[t]) expect(m.text).toContain(params[k]!.replace(/\s+/g, " "));
        // Los parámetros no agregan marcas: mismas etiquetas y comillas que con "x".
        for (const ch of ["<", ">", '"']) expect(m.html.split(ch).length).toBe(baseline.html.split(ch).length);
      }),
    );
  });
});
