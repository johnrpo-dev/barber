import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ActiveDevice, devicesToRevoke, MAX_ACTIVE_DEVICES } from "./devices";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1) + minutes * 60_000);

describe("tope de navegadores recordados", () => {
  it("con 5 o menos no revoca nada", () => {
    const active: ActiveDevice[] = [1n, 2n, 3n, 4n, 5n].map((id) => ({ id, createdAt: at(Number(id)), lastUsedAt: null }));
    expect(devicesToRevoke(active, 5n)).toEqual([]);
  });

  it("con 6 revoca el que lleva más tiempo sin usarse, no el más viejo", () => {
    const active: ActiveDevice[] = [
      { id: 1n, createdAt: at(0), lastUsedAt: at(500) }, // el más viejo, pero se usó ayer
      { id: 2n, createdAt: at(10), lastUsedAt: null },
      { id: 3n, createdAt: at(20), lastUsedAt: at(30) },
      { id: 4n, createdAt: at(40), lastUsedAt: null },
      { id: 5n, createdAt: at(50), lastUsedAt: null },
      { id: 6n, createdAt: at(600), lastUsedAt: null }, // el nuevo
    ];
    expect(devicesToRevoke(active, 6n)).toEqual([2n]);
  });

  it("el recién recordado nunca se revoca, aunque su hora parezca vieja", () => {
    const active: ActiveDevice[] = [
      ...[1n, 2n, 3n, 4n, 5n].map((id) => ({ id, createdAt: at(100), lastUsedAt: at(200) })),
      { id: 9n, createdAt: at(0), lastUsedAt: null },
    ];
    const revoked = devicesToRevoke(active, 9n);
    expect(revoked).not.toContain(9n);
    expect(revoked).toHaveLength(1);
  });

  const device = fc.record({
    id: fc.bigInt({ min: 1n, max: 10_000n }),
    createdAt: fc.integer({ min: 0, max: 100_000 }).map(at),
    lastUsedAt: fc.option(fc.integer({ min: 0, max: 100_000 }).map(at), { nil: null }),
  });

  it("propiedad: quedan como máximo 5, siempre el nuevo, y los revocados son los de uso más viejo", () => {
    fc.assert(
      fc.property(fc.uniqueArray(device, { minLength: 1, maxLength: 20, selector: (d) => d.id }), fc.nat(), (active, pick) => {
        const keep = active[pick % active.length]!.id;
        const revoked = devicesToRevoke(active, keep);
        const left = active.filter((d) => !revoked.includes(d.id));
        expect(revoked).not.toContain(keep);
        expect(new Set(revoked).size).toBe(revoked.length);
        expect(left.length).toBe(Math.min(active.length, MAX_ACTIVE_DEVICES));
        // Ninguno de los que quedan (salvo el nuevo) se usó antes que uno revocado.
        const seen = (d: ActiveDevice) => (d.lastUsedAt ?? d.createdAt).getTime();
        const revokedRows = active.filter((d) => revoked.includes(d.id));
        for (const kept of left.filter((d) => d.id !== keep)) {
          for (const r of revokedRows) expect(seen(kept)).toBeGreaterThanOrEqual(seen(r));
        }
      }),
    );
  });
});
