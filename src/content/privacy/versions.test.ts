import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CURRENT_PRIVACY, CURRENT_PRIVACY_VERSION, PRIVACY_VERSIONS, privacyVersion } from "./versions";

/** SHA-256 de JSON.stringify de cada versión publicada. Solo se AGREGAN líneas. */
const FROZEN: Record<string, string> = {
  "2026-11-01": "3fffb583876d66b7785506b89cc926028547f7a4fe94ac15a761ea027d26cf65",
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

  it("propiedad: solo se encuentran versiones publicadas", () => {
    const published = new Set(PRIVACY_VERSIONS.map((v) => v.version));
    fc.assert(fc.property(fc.string(), (v) => (privacyVersion(v) !== undefined) === published.has(v)));
    expect(privacyVersion(CURRENT_PRIVACY_VERSION)).toBe(CURRENT_PRIVACY);
  });
});
