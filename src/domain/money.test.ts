import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { add, allocate, format, fromUnits, money, percentOf, subtract, sum } from "./money";

describe("money", () => {
  it("suma sin errores de punto flotante", () => {
    // 0.1 + 0.2 en number da 0.30000000000000004; aquí debe ser exacto.
    expect(add(money(10n), money(20n)).minor).toBe(30n);
  });

  it("calcula una comisión del 40 % de un corte de $25.000", () => {
    expect(percentOf(fromUnits(25_000n), 4_000n)).toEqual(fromUnits(10_000n));
  });

  it("redondea la mitad hacia fuera de cero", () => {
    expect(percentOf(money(5n), 1_000n).minor).toBe(1n); // 0,5 → 1
    expect(percentOf(money(-5n), 1_000n).minor).toBe(-1n);
  });

  it("formatea en pesos colombianos", () => {
    expect(format(fromUnits(25_000n))).toMatch(/\$\s?25\.000/);
  });

  it("allocate nunca pierde ni crea centavos", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.array(fc.bigInt({ min: 0n, max: 10_000n }), { minLength: 1, maxLength: 8 }).filter((ws) => ws.some((w) => w > 0n)),
        (minor, weights) => {
          const parts = allocate(money(minor), weights);
          expect(sum(parts).minor).toBe(minor);
        },
      ),
    );
  });

  it("restar y volver a sumar devuelve el original", () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt(), (a, b) => {
        expect(add(subtract(money(a), money(b)), money(b)).minor).toBe(a);
      }),
    );
  });
});
