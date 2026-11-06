import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidClientError } from "./client";
import {
  assertBookingConsent,
  CONSENT_PURPOSES,
  type ConsentPurpose,
  type ConsentRecord,
  consentRows,
  latestConsent,
  needsConsentRenewal,
  renewalRows,
  WITHDRAWABLE_PURPOSES,
} from "./consent";

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

describe("retirar una autorización desde la ficha (sprint 7)", () => {
  it("se retiran el recordatorio y las promociones; el tratamiento de datos no (eso es la supresión)", () => {
    expect([...WITHDRAWABLE_PURPOSES]).toEqual(["reminders", "marketing"]);
  });

  const row = fc.record({ id: fc.bigInt({ min: 1n, max: 10_000n }), purpose: fc.constantFrom(...CONSENT_PURPOSES), granted: fc.boolean() });

  it("propiedad: una fila de retiro posterior manda en su propósito y no toca los otros", () => {
    fc.assert(
      fc.property(fc.uniqueArray(row, { maxLength: 30, selector: (r) => r.id }), fc.constantFrom(...WITHDRAWABLE_PURPOSES), (rows, purpose) => {
        const maxId = rows.reduce((m, r) => (r.id > m ? r.id : m), 0n);
        const after = [...rows, { id: maxId + 1n, purpose, granted: false }];
        expect(latestConsent(after, purpose)).toBe(false);
        for (const other of CONSENT_PURPOSES.filter((p) => p !== purpose)) expect(latestConsent(after, other)).toBe(latestConsent(rows, other));
      }),
    );
  });
});

describe("volver a autorizar al cliente recordado (sprint 7)", () => {
  const CURRENT = "2026-11-05b";
  const rec = (granted: boolean, textVersion: string, source: ConsentRecord["source"] = "online"): ConsentRecord => ({ granted, textVersion, source });

  it("autorizó con una política anterior: se le pide una vez; con la vigente, no", () => {
    expect(needsConsentRenewal({ data_processing: rec(true, "2026-11-03"), reminders: rec(false, "2026-11-03") }, CURRENT)).toBe(true);
    expect(needsConsentRenewal({ data_processing: rec(true, CURRENT), reminders: rec(true, CURRENT) }, CURRENT)).toBe(false);
  });

  it("sin tratamiento de datos vigente no aplica (vuelve al flujo con código)", () => {
    expect(needsConsentRenewal({}, CURRENT)).toBe(false);
    expect(needsConsentRenewal({ data_processing: rec(false, "2026-11-01") }, CURRENT)).toBe(false);
  });

  it("si el personal retiró el recordatorio, ese retiro se respeta: no se pide ni se deshace", () => {
    const latest = { data_processing: rec(true, CURRENT), reminders: rec(false, CURRENT, "staff") };
    expect(needsConsentRenewal(latest, CURRENT)).toBe(false);
    const old = { data_processing: rec(true, "2026-11-03"), reminders: rec(false, CURRENT, "staff") };
    expect(needsConsentRenewal(old, CURRENT)).toBe(true);
    expect(renewalRows(old, CURRENT)).toEqual([{ purpose: "data_processing", granted: true }]);
  });

  it("si la persona dijo que no al recordatorio en línea (con una política anterior), ese no se respeta", () => {
    const old = { data_processing: rec(true, "2026-11-03"), reminders: rec(false, "2026-11-03", "online"), marketing: rec(true, "2026-11-03") };
    expect(needsConsentRenewal(old, CURRENT)).toBe(true);
    expect(renewalRows(old, CURRENT)).toEqual([{ purpose: "data_processing", granted: true }]);
    const current = { data_processing: rec(true, CURRENT), reminders: rec(false, "2026-11-03", "online") };
    expect(needsConsentRenewal(current, CURRENT)).toBe(false);
  });

  it("la renovación escribe el recordatorio solo si no había fila o si era un sí viejo; las promociones no se tocan", () => {
    expect(renewalRows({ data_processing: rec(true, "2026-11-03"), reminders: rec(true, "2026-11-03"), marketing: rec(true, "2026-11-03") }, CURRENT)).toEqual([
      { purpose: "data_processing", granted: true },
      { purpose: "reminders", granted: true },
    ]);
    expect(renewalRows({ data_processing: rec(true, "2026-11-03") }, CURRENT)).toEqual([
      { purpose: "data_processing", granted: true },
      { purpose: "reminders", granted: true },
    ]);
  });

  const version = fc.constantFrom("2026-11-01", "2026-11-03", "2026-11-05", CURRENT);
  const record = fc.record({ granted: fc.boolean(), textVersion: version, source: fc.constantFrom("online" as const, "staff" as const) });
  const latestArb = fc.record(
    { data_processing: record, reminders: record, marketing: record },
    { requiredKeys: [] },
  );

  it("propiedad: tras renovar, no se vuelve a pedir, las promociones quedan igual y un no previo al recordatorio sigue en no", () => {
    fc.assert(
      fc.property(latestArb, (latest) => {
        if (!needsConsentRenewal(latest, CURRENT)) return;
        const after: Partial<Record<ConsentPurpose, ConsentRecord>> = { ...latest };
        for (const r of renewalRows(latest, CURRENT)) after[r.purpose] = { granted: r.granted, textVersion: CURRENT, source: "online" };
        expect(needsConsentRenewal(after, CURRENT)).toBe(false);
        expect(after.marketing).toEqual(latest.marketing);
        expect(after.data_processing?.granted).toBe(true);
        if (latest.reminders?.granted === false) expect(after.reminders).toEqual(latest.reminders);
      }),
    );
  });
});
