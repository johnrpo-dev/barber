import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cleanText, isEmojiTail } from "./text";

// Lo que nunca debe quedar: controles, separadores de línea y formato invisible (salvo el U+200D entre emojis).
const FORBIDDEN = /[\p{Cc}\u2028\u2029\u115F\u1160\u3164\uFFA0]|(?!\u200D)\p{Cf}/u;

describe("cleanText", () => {
  it("deja igual un texto normal", () => {
    expect(cleanText("Distribuidora El Barbero")).toBe("Distribuidora El Barbero");
    expect(cleanText("Corte + barba (niño) — $30.000")).toBe("Corte + barba (niño) — $30.000");
  });

  it("quita los controles bidi y los invisibles de ancho cero", () => {
    // U+202E da vuelta lo que sigue: "Juan \u202EzeréP" se vería como "Juan Pérez" al revés.
    expect(cleanText("Juan \u202Ezerép")).toBe("Juan zerép");
    expect(cleanText("Pro\u200Bveedor")).toBe("Proveedor");
    expect(cleanText("\uFEFFCarlos\u2066\u2069")).toBe("Carlos");
    expect(cleanText("Ana\u00ADMaría")).toBe("AnaMaría");
    expect(cleanText("\u200E3001234567\u200F")).toBe("3001234567");
  });

  it("un nombre hecho solo de invisibles queda vacío", () => {
    expect(cleanText("\u3164")).toBe("");
    expect(cleanText("\u200B\u200C\u200D")).toBe("");
    expect(cleanText(" \u115F\u1160 ")).toBe("");
  });

  it("saltos, tabulaciones, controles y espacios raros se vuelven un solo espacio", () => {
    expect(cleanText("  Nota\r\nde\tcaja  ")).toBe("Nota de caja");
    expect(cleanText("a\u0085b\u2028c\u2029d")).toBe("a b c d");
    expect(cleanText("a\u00A0\u2003\u3000b")).toBe("a b");
    expect(cleanText("a \u200B b")).toBe("a b");
    expect(cleanText("a\u0007b")).toBe("a b");
  });

  it("conserva los emojis compuestos y quita el unidor suelto", () => {
    expect(cleanText("Barbero 👨\u200D💻")).toBe("Barbero 👨\u200D💻");
    expect(cleanText("👨🏽\u200D💻 listo")).toBe("👨🏽\u200D💻 listo");
    expect(cleanText("❤\uFE0F\u200D🔥")).toBe("❤\uFE0F\u200D🔥");
    expect(cleanText("Ana\u200DMaría")).toBe("AnaMaría");
    expect(cleanText("👨\u200D")).toBe("👨");
  });

  it("normaliza a NFC: la tilde aparte y la letra acentuada son lo mismo", () => {
    expect(cleanText("Jose\u0301")).toBe("José");
    expect(cleanText("Jose\u200B\u0301")).toBe("José");
  });

  it("propiedad: es idempotente y nunca deja controles, invisibles, espacios dobles ni bordes", () => {
    const tricky = fc.constantFrom(
      "\u202E", "\u202A", "\u2066", "\u2069", "\u200B", "\u200C", "\u200D", "\u200E", "\uFEFF", "\u00AD", "\u3164",
      "\u115F", "\u0085", "\u2028", "\n", "\r", "\t", "\u0000", "\u00A0", " ", "\u0301", "e", "é", "👨", "💻", "🏽", "\uFE0F", "a",
    );
    const text = fc.oneof(fc.string({ unit: "grapheme" }), fc.string({ unit: "binary" }), fc.array(tricky, { maxLength: 30 }).map((a) => a.join("")));
    fc.assert(
      fc.property(text, (input) => {
        const out = cleanText(input);
        expect(cleanText(out)).toBe(out);
        expect(FORBIDDEN.test(out)).toBe(false);
        expect(out).toBe(out.trim());
        expect(/\s{2}/u.test(out)).toBe(false);
        expect(out).toBe(out.normalize("NFC"));
        // Cada U+200D que queda une dos emojis.
        for (let i = out.indexOf("\u200D"); i !== -1; i = out.indexOf("\u200D", i + 1)) {
          const before = [...out.slice(0, i)].map((ch) => ch.codePointAt(0)!);
          let prev = before.pop();
          if (prev !== undefined && isEmojiTail(prev)) prev = before.pop();
          expect(prev !== undefined && /^\p{Extended_Pictographic}$/u.test(String.fromCodePoint(prev))).toBe(true);
          expect(/^\p{Extended_Pictographic}/u.test(out.slice(i + 1))).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("propiedad: un texto ASCII imprimible con espacios sencillos no cambia", () => {
    const word = fc.stringMatching(/^[!-~]{1,12}$/);
    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 8 }), (words) => {
        expect(cleanText(words.join(" "))).toBe(words.join(" "));
      }),
    );
  });
});
