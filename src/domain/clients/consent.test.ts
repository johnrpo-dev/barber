import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidClientError } from "./client";
import { assertBookingConsent, CONSENT_PURPOSES, type ConsentPurpose, consentRows, latestConsent } from "./consent";

describe("consentimientos", () => {
  it("sin autorizar el tratamiento no se reserva; recordatorios y promociones son opcionales", () => {
    expect(() => assertBookingConsent({ dataProcessing: false, reminders: true, marketing: true })).toThrow(InvalidClientError);
    expect(() => assertBookingConsent({ dataProcessing: false, reminders: true, marketing: true })).toThrow(
      "Para reservar debes autorizar el tratamiento de tus datos",
    );
    expect(() => assertBookingConsent({ dataProcessing: true, reminders: false, marketing: false })).not.toThrow();
  });

  it("siempre escribe las tres filas, también los no", () => {
    expect(consentRows({ dataProcessing: true, reminders: false, marketing: false })).toEqual([
      { purpose: "data_processing", granted: true },
      { purpose: "reminders", granted: false },
      { purpose: "marketing", granted: false },
    ]);
  });

  it("manda la última fila del propósito; sin filas, no hay consentimiento", () => {
    const rows = [
      { id: 1n, purpose: "reminders" as const, granted: true },
      { id: 7n, purpose: "reminders" as const, granted: false },
      { id: 3n, purpose: "marketing" as const, granted: true },
    ];
    expect(latestConsent(rows, "reminders")).toBe(false);
    expect(latestConsent(rows, "marketing")).toBe(true);
    expect(latestConsent(rows, "data_processing")).toBe(false);
    expect(latestConsent([], "reminders")).toBe(false);
  });

  it("propiedad: es el valor de la fila de mayor id de ese propósito, sin importar el orden", () => {
    const row = fc.record({ id: fc.bigInt({ min: 1n, max: 10_000n }), purpose: fc.constantFrom(...CONSENT_PURPOSES), granted: fc.boolean() });
    const rowsArb = fc.uniqueArray(row, { maxLength: 30, selector: (r) => r.id });
    fc.assert(
      fc.property(rowsArb, fc.constantFrom(...CONSENT_PURPOSES), (rows, purpose: ConsentPurpose) => {
        const ofPurpose = rows.filter((r) => r.purpose === purpose).sort((a, b) => (a.id < b.id ? -1 : 1));
        expect(latestConsent(rows, purpose)).toBe(ofPurpose.at(-1)?.granted ?? false);
      }),
    );
  });

  it("propiedad: las filas reflejan exactamente las elecciones", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (dataProcessing, reminders, marketing) => {
        const rows = consentRows({ dataProcessing, reminders, marketing });
        expect(rows.map((r) => r.purpose)).toEqual([...CONSENT_PURPOSES]);
        const withIds = rows.map((r, i) => ({ ...r, id: BigInt(i + 1) }));
        expect(latestConsent(withIds, "data_processing")).toBe(dataProcessing);
        expect(latestConsent(withIds, "reminders")).toBe(reminders);
        expect(latestConsent(withIds, "marketing")).toBe(marketing);
      }),
    );
  });
});
