import { isDeepStrictEqual } from "node:util";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertSameRequest, canonicalJson, IdempotencyConflictError, idempotencyDecision, requestHash } from "./idempotency";

// Valores como los que llevan las peticiones: texto, enteros, bigint (montos, IDs), fechas,
// booleanos, null, arreglos y objetos anidados.
const key = fc.string({ maxLength: 6 }).filter((k) => k !== "__proto__");
const { payload } = fc.letrec<{ payload: unknown }>((tie) => ({
  payload: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.string({ maxLength: 8 }),
    fc.integer(),
    fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }),
    fc.boolean(),
    fc.constant(null),
    fc.date({ noInvalidDate: true }),
    fc.array(tie("payload"), { maxLength: 4 }),
    // Las peticiones son objetos normales (los de prototipo null se codifican igual, pero
    // isDeepStrictEqual los distingue).
    fc.dictionary(key, tie("payload"), { maxKeys: 4, noNullPrototype: true }),
  ),
}));

/** El mismo objeto con las claves en otro orden (en todos los niveles). */
function shuffleKeys(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((v, i) => shuffleKeys(v, seed + i));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value);
    const rotated = entries.length ? [...entries.slice(seed % entries.length), ...entries.slice(0, seed % entries.length)].reverse() : entries;
    return Object.fromEntries(rotated.map(([k, v]) => [k, shuffleKeys(v, seed + 1)]));
  }
  return value;
}

describe("huella de la petición", () => {
  it("no depende del orden de las claves", () => {
    fc.assert(
      fc.property(payload, fc.nat(), (p, seed) => {
        expect(canonicalJson(shuffleKeys(p, seed))).toBe(canonicalJson(p));
        expect(requestHash(shuffleKeys(p, seed))).toBe(requestHash(p));
      }),
    );
  });

  it("dos peticiones tienen la misma huella si y solo si tienen el mismo contenido", () => {
    fc.assert(
      fc.property(payload, payload, (a, b) => {
        expect(canonicalJson(a) === canonicalJson(b)).toBe(isDeepStrictEqual(a, b));
      }),
      { numRuns: 500 },
    );
  });

  it("cambiar un solo campo cambia la huella", () => {
    fc.assert(
      fc.property(fc.dictionary(key, payload, { minKeys: 1, maxKeys: 5, noNullPrototype: true }), payload, (p, replacement) => {
        const field = Object.keys(p)[0]!;
        fc.pre(!isDeepStrictEqual(p[field], replacement));
        expect(requestHash({ ...p, [field]: replacement })).not.toBe(requestHash(p));
      }),
    );
  });

  it("distingue tipos que JSON confundiría", () => {
    expect(canonicalJson(1)).not.toBe(canonicalJson(1n));
    expect(canonicalJson("1")).not.toBe(canonicalJson(1));
    expect(canonicalJson(new Date(0))).not.toBe(canonicalJson(new Date(0).toISOString()));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe(canonicalJson({ b: 1 }));
    expect(requestHash({ monto: 2_500_000n })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rechaza valores que no tienen una forma canónica", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});

describe("decisión de idempotencia", () => {
  const hash = fc.stringMatching(/^[0-9a-f]{64}$/);

  it("misma clave y mismo contenido devuelve lo original; otro contenido es un conflicto", () => {
    fc.assert(
      fc.property(hash, hash, (stored, incoming) => {
        expect(idempotencyDecision(undefined, incoming)).toBe("new");
        expect(idempotencyDecision({ requestHash: incoming }, incoming)).toBe("replay");
        expect(idempotencyDecision({ requestHash: stored }, incoming)).toBe(stored === incoming ? "replay" : "conflict");
        if (stored !== incoming) {
          expect(() => assertSameRequest({ requestHash: stored }, incoming)).toThrow(IdempotencyConflictError);
        }
      }),
    );
  });

  it("las filas anteriores a la huella (null) se aceptan como reintento", () => {
    expect(idempotencyDecision({ requestHash: null }, "a".repeat(64))).toBe("replay");
  });

  it("el conflicto lleva un mensaje en español para el personal", () => {
    expect(new IdempotencyConflictError().message).toMatch(/otros datos/);
  });
});
