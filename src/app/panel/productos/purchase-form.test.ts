import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { highCostLines } from "./purchase-form";

// El aviso de costo alto en la compra de mercancía: casi siempre es un error de dedo y la compra no se
// borra. Caso real de las pruebas: 4 bálsamos "a $6.000.060.000" (el costo escrito dos veces).
const products = [
  { id: "1", name: "Bálsamo para barba", priceMinor: "3800000" }, // $38.000
  { id: "2", name: "Cera para peinar", priceMinor: "3500000" }, // $35.000
];
const line = (productId: string | null, quantity: string, amount: string) => ({ key: `${productId}-${quantity}-${amount}`, productId, quantity, amount });

describe("highCostLines", () => {
  it("avisa cuando el costo por unidad supera el precio de venta", () => {
    const high = highCostLines([line("1", "4", "6000060000")], products);
    expect(high).toHaveLength(1);
    expect(high[0]!.name).toBe("Bálsamo para barba");
    expect(high[0]!.unitCost.minor).toBe(150001500000n);
  });

  it("no avisa en una compra normal, ni con el costo igual al precio", () => {
    expect(highCostLines([line("1", "4", "60000"), line("2", "1", "35000")], products)).toEqual([]);
  });

  it("no avisa mientras la línea está incompleta", () => {
    expect(highCostLines([line(null, "1", "999999"), line("1", "", "999999"), line("1", "0", "999999"), line("1", "2", "")], products)).toEqual([]);
  });

  it("propiedad: avisa exactamente cuando costo total > precio × unidades", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.bigInt({ min: 0n, max: 99_999_999_999n }), (quantity, units) => {
        const flagged = highCostLines([line("1", String(quantity), units.toString())], products).length === 1;
        expect(flagged).toBe(units * 100n > 3_800_000n * BigInt(quantity));
      }),
    );
  });
});
