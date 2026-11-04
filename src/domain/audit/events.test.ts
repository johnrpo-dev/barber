import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_CATEGORY, AUDIT_LABELS, type AuditValue, auditSummary, configChanges, MAX_AUDIT_SUMMARY } from "./events";

// docs/sprint-5-comisiones-informes.md §8 y §11.

describe("bitácora: catálogo", () => {
  it("toda acción tiene categoría y etiqueta", () => {
    for (const a of AUDIT_ACTIONS) {
      expect(AUDIT_CATEGORY[a]).toBeDefined();
      expect(AUDIT_LABELS[a].length).toBeGreaterThan(0);
    }
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it("resumen: una línea, sin controles, recortado a 300, nunca vacío", () => {
    expect(auditSummary("  Cobró\nuna\tventa  ")).toBe("Cobró una venta");
    expect(auditSummary("")).toBe("Sin detalle");
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (s) => {
        const out = auditSummary(s);
        expect([...out].length).toBeLessThanOrEqual(MAX_AUDIT_SUMMARY);
        expect(out.length).toBeGreaterThan(0);
        expect(/[\u0000-\u001f\u007f]/.test(out)).toBe(false);
      }),
    );
  });
});

describe("configChanges", () => {
  it("ejemplo: precio y comisión del corte", () => {
    expect(
      configChanges({ name: "Corte", price: "3000000", commissionBps: "4000" }, { name: "Corte", price: "3500000", commissionBps: "4000" }, [
        "name",
        "price",
        "commissionBps",
      ]),
    ).toEqual([{ field: "price", before: "3000000", after: "3500000" }]);
  });

  const value: fc.Arbitrary<AuditValue> = fc.oneof(fc.constantFrom("a", "b", "1"), fc.boolean(), fc.constant(null));
  const obj = fc.dictionary(fc.constantFrom("name", "price", "secret", "email", "active"), value);

  it("propiedad: solo campos de la lista blanca; vacío si no hubo cambios", () => {
    const fields = ["name", "price", "active"] as const;
    fc.assert(
      fc.property(obj, obj, (before, after) => {
        const changes = configChanges(before, after, fields);
        for (const c of changes) {
          expect(fields).toContain(c.field);
          expect(c.before).not.toBe(c.after);
        }
        expect(configChanges(before, before, fields)).toEqual([]);
        const expectedFields = fields.filter((f) => (before[f] ?? null) !== (after[f] ?? null));
        expect(changes.map((c) => c.field)).toEqual(expectedFields);
      }),
    );
  });
});
