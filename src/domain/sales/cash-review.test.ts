import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromUnits, money } from "../money";
import { CashError, DEFAULT_CASH_REVIEW_THRESHOLD, needsCashReview } from "./cash";

// Revisión de cierres (docs/sprint-4-cobro-caja.md §9.2): un faltante o sobrante mayor que el umbral
// de la sede deja el cierre marcado para el dueño. La base hace el mismo cálculo (trigger de 0011).

describe("revisión de un cierre de caja: ejemplos", () => {
  it("por defecto el umbral es $20.000", () => {
    expect(DEFAULT_CASH_REVIEW_THRESHOLD).toEqual(fromUnits(20_000n));
  });

  it("igual al umbral no se marca; un peso más, sí (faltante o sobrante)", () => {
    const t = fromUnits(20_000n);
    expect(needsCashReview(fromUnits(0n), t)).toBe(false);
    expect(needsCashReview(fromUnits(20_000n), t)).toBe(false);
    expect(needsCashReview(fromUnits(-20_000n), t)).toBe(false);
    expect(needsCashReview(fromUnits(20_001n), t)).toBe(true);
    expect(needsCashReview(fromUnits(-20_001n), t)).toBe(true);
  });

  it("con umbral cero, cualquier diferencia se revisa", () => {
    expect(needsCashReview(money(1n), money(0n))).toBe(true);
    expect(needsCashReview(money(0n), money(0n))).toBe(false);
  });

  it("un umbral negativo es un error", () => {
    expect(() => needsCashReview(money(0n), money(-1n))).toThrow(CashError);
  });
});

describe("revisión de un cierre de caja: propiedades", () => {
  const minor = fc.bigInt({ min: -(10n ** 13n), max: 10n ** 13n });
  const threshold = fc.bigInt({ min: 0n, max: 10n ** 13n });

  it("faltante y sobrante del mismo tamaño se tratan igual", () => {
    fc.assert(fc.property(minor, threshold, (d, t) => needsCashReview(money(d), money(t)) === needsCashReview(money(-d), money(t))));
  });

  it("es exactamente |diferencia| > umbral", () => {
    fc.assert(fc.property(minor, threshold, (d, t) => needsCashReview(money(d), money(t)) === (d < 0n ? -d : d) > t));
  });

  it("subir el umbral nunca marca un cierre que antes no se marcaba", () => {
    fc.assert(
      fc.property(minor, threshold, fc.bigInt({ min: 0n, max: 10n ** 12n }), (d, t, more) => {
        if (!needsCashReview(money(d), money(t))) expect(needsCashReview(money(d), money(t + more))).toBe(false);
      }),
    );
  });
});
