import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { contactReadKey, MAX_CLIENTS_PER_READ, READ_AUDIT_WINDOW_MS, readWindowStart } from "./retention";

describe("clave de la auditoría de lecturas", () => {
  it("sin clientes no hay nada que registrar", () => {
    expect(contactReadKey([])).toBeNull();
  });

  it("propiedad: el orden y las repeticiones no cambian la clave", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 10_000n }), { minLength: 1, maxLength: 50 }), (ids) => {
        const a = contactReadKey(ids)!;
        const b = contactReadKey([...ids].reverse().concat(ids))!;
        expect(b).toEqual(a);
        expect(a.clientIds).toEqual([...new Set(ids)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
        expect(a.clientsHash).toMatch(/^[0-9a-f]{64}$/);
      }),
    );
  });

  it("propiedad: conjuntos distintos dan claves distintas", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.bigInt({ min: 1n, max: 1_000n }), { minLength: 2, maxLength: 20 }), (ids) => {
        expect(contactReadKey(ids)!.clientsHash).not.toBe(contactReadKey(ids.slice(1))!.clientsHash);
      }),
    );
  });

  it("nunca pasa del tope del CHECK de la tabla", () => {
    const many = Array.from({ length: MAX_CLIENTS_PER_READ + 10 }, (_, i) => BigInt(i + 1));
    expect(contactReadKey(many)!.clientIds).toHaveLength(MAX_CLIENTS_PER_READ);
  });

  it("propiedad: la ventana contiene el instante y dura lo mismo", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (ms) => {
        const start = readWindowStart(new Date(ms)).getTime();
        expect(start <= ms && ms < start + READ_AUDIT_WINDOW_MS).toBe(true);
      }),
    );
  });
});
