import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PII_RETENTION_DAYS, READ_AUDIT_RETENTION_DAYS } from "@/domain/clients/retention";
import { REMINDER_LEAD_MS, REMINDER_MIN_BOOKING_LEAD_MS } from "@/domain/notifications/schedule";
import { CURRENT_PRIVACY, CURRENT_PRIVACY_VERSION, PRIVACY_VERSIONS, privacyVersion } from "./versions";

/** SHA-256 de JSON.stringify de cada versión publicada. Solo se AGREGAN líneas. */
const FROZEN: Record<string, string> = {
  "2026-11-01": "3fffb583876d66b7785506b89cc926028547f7a4fe94ac15a761ea027d26cf65",
  "2026-11-02": "cff2321f7abb0ea1e7cb13bda0257b9ef43602d86acd7df2a40a5c0cbae5db92",
  "2026-11-03": "a6f50ef64b79c2545a3baa8ed85365715ca8bc1a8a16f3775cd31ece8947131b",
  "2026-11-05": "86b395f4b3bf4b305eaf671a9c9df8b95dc2a6b48a22721414f385479cb10dc0",
  "2026-11-05b": "47e71130714a002d18ef21ad8c402e3744d9d7bffa705bb24bdf751e5df0fdd6",
};

describe("política de privacidad versionada", () => {
  it("ninguna versión publicada cambió", () => {
    for (const v of PRIVACY_VERSIONS) {
      const frozen = FROZEN[v.version];
      if (!frozen) continue; // versión nueva todavía sin congelar: el test siguiente lo exige
      const actual = createHash("sha256").update(JSON.stringify(v)).digest("hex");
      expect(
        actual,
        `La política ${v.version} ya está publicada y hay consentimientos que apuntan a ella: no edites una versión publicada: crea una nueva al final de PRIVACY_VERSIONS.`,
      ).toBe(frozen);
    }
  });

  it("toda versión está congelada y ninguna congelada desapareció", () => {
    expect(PRIVACY_VERSIONS.map((v) => v.version).sort(), "Congela el SHA-256 de la versión nueva en FROZEN y no borres versiones publicadas").toEqual(
      Object.keys(FROZEN).sort(),
    );
  });

  it("las versiones van en orden y la vigente es la última", () => {
    const dates = PRIVACY_VERSIONS.map((v) => v.publishedOn);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(PRIVACY_VERSIONS.map((v) => v.version)).size).toBe(PRIVACY_VERSIONS.length);
    expect(CURRENT_PRIVACY.version).toBe(CURRENT_PRIVACY_VERSION);
    expect(PRIVACY_VERSIONS.at(-1)?.version).toBe(CURRENT_PRIVACY_VERSION);
  });

  it("cubre lo que exige la Ley 1581 y deja los datos del responsable al dueño", () => {
    const text = JSON.stringify(CURRENT_PRIVACY);
    for (const id of ["responsable", "datos", "finalidades", "recordatorios", "derechos", "ejercicio", "encargados", "conservacion", "cambios"]) {
      expect(CURRENT_PRIVACY.sections.some((s) => s.id === id)).toBe(true);
    }
    for (const placeholder of ["[Razón social]", "[NIT]", "[Dirección]", "[Correo de habeas data]"]) expect(text).toContain(placeholder);
    expect(text).toContain("10 días hábiles");
    expect(text).toContain("15 días hábiles");
    expect(text).toContain("Superintendencia de Industria y Comercio");
  });

  it("la vigente promete un solo recordatorio, con las mismas reglas que el worker, y nombra a Barbería Villa (sprint 6)", () => {
    const text = JSON.stringify(CURRENT_PRIVACY);
    // Las cifras del texto son las de domain/notifications/schedule.ts: si cambian allá, cambia la política.
    expect(REMINDER_LEAD_MS).toBe(3 * 3_600_000);
    expect(REMINDER_MIN_BOOKING_LEAD_MS).toBe(6 * 3_600_000);
    expect(text).toContain("un único recordatorio unas 3 horas antes");
    expect(text).toContain("más de 6 horas de anticipación");
    expect(text).toContain("opera Barbería Villa");
  });

  it("propiedad: solo se encuentran versiones publicadas", () => {
    const published = new Set(PRIVACY_VERSIONS.map((v) => v.version));
    fc.assert(fc.property(fc.string(), (v) => (privacyVersion(v) !== undefined) === published.has(v)));
    expect(privacyVersion(CURRENT_PRIVACY_VERSION)).toBe(CURRENT_PRIVACY);
  });

  it("la vigente dice cuánto se guardan los restos de la reserva y el registro de consultas (sprint 5)", () => {
    const keep = CURRENT_PRIVACY.sections.find((sec) => sec.id === "conservacion")!.paragraphs.join(" ");
    expect(keep).toContain(`a los ${PII_RETENTION_DAYS} días`);
    expect(keep).toContain(`a los ${READ_AUDIT_RETENTION_DAYS} días`);
  });
});
