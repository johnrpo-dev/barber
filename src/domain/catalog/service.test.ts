import { describe, expect, it } from "vitest";
import { fromUnits, money } from "../money";
import { assertValidService, InvalidServiceError, percentToBps, type ServiceDraft } from "./service";

const corte: ServiceDraft = {
  name: "Corte clásico",
  durationMin: 30,
  bufferMin: 5,
  price: fromUnits(25_000n),
  commissionBps: 4_000,
};

describe("servicios del catálogo", () => {
  it("acepta un corte de $25.000, 30 minutos, comisión del 40 %", () => {
    expect(() => assertValidService(corte)).not.toThrow();
  });

  it.each([
    ["nombre vacío", { name: " " }],
    ["duración de 7 minutos", { durationMin: 7 }],
    ["duración de 0", { durationMin: 0 }],
    ["margen negativo", { bufferMin: -5 }],
    ["precio con centavos", { price: money(2_500_050n) }],
    ["precio negativo", { price: fromUnits(-1n) }],
    ["comisión mayor al 100 %", { commissionBps: 10_001 }],
    ["comisión con fracción de punto básico", { commissionBps: 40.5 }],
  ])("rechaza %s", (_, override) => {
    expect(() => assertValidService({ ...corte, ...override } as ServiceDraft)).toThrow(InvalidServiceError);
  });

  it("convierte porcentajes escritos a puntos básicos sin float", () => {
    expect(percentToBps("40")).toBe(4_000);
    expect(percentToBps("40,5")).toBe(4_050);
    expect(percentToBps("33.33")).toBe(3_333);
    expect(percentToBps("0")).toBe(0);
    expect(() => percentToBps("40%")).toThrow(InvalidServiceError);
    expect(() => percentToBps("-5")).toThrow(InvalidServiceError);
  });
});
