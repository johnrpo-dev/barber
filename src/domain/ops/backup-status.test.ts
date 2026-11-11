import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BACKUP_MAX_AGE_MS, backupState, type BackupRunSummary, wholeDaysBetween } from "./backup-status";

const at = (iso: string) => new Date(iso);
const now = at("2026-11-11T13:00:00Z"); // 8:00 a. m. en Bogotá

describe("backupState", () => {
  it("sin registros: none", () => {
    expect(backupState({ latest: null, lastOkAt: null }, now, BACKUP_MAX_AGE_MS)).toEqual({ state: "none" });
  });

  it("el de anoche salió bien: ok", () => {
    const t = at("2026-11-11T08:10:00Z");
    expect(backupState({ latest: { ok: true, finishedAt: t }, lastOkAt: t }, now, BACKUP_MAX_AGE_MS)).toEqual({ state: "ok", lastOkAt: t });
  });

  it("el de anoche falló aunque el de antier saliera bien: failed, con el último bueno", () => {
    const failed = at("2026-11-11T08:10:00Z");
    const good = at("2026-11-10T08:10:00Z");
    expect(backupState({ latest: { ok: false, finishedAt: failed }, lastOkAt: good }, now, BACKUP_MAX_AGE_MS)).toEqual({
      state: "failed",
      failedAt: failed,
      lastOkAt: good,
    });
  });

  it("falló y luego se repitió bien: ok", () => {
    const retry = at("2026-11-11T10:00:00Z");
    expect(backupState({ latest: { ok: true, finishedAt: retry }, lastOkAt: retry }, now, BACKUP_MAX_AGE_MS).state).toBe("ok");
  });

  it("el último bueno tiene más de 26 h: stale (el timer dejó de correr)", () => {
    const t = at("2026-11-09T08:10:00Z");
    expect(backupState({ latest: { ok: true, finishedAt: t }, lastOkAt: t }, now, BACKUP_MAX_AGE_MS)).toEqual({ state: "stale", lastOkAt: t });
  });

  it("justo en el borde de 26 h sigue ok; un milisegundo después, stale", () => {
    const edge = new Date(now.getTime() - BACKUP_MAX_AGE_MS);
    expect(backupState({ latest: { ok: true, finishedAt: edge }, lastOkAt: edge }, now, BACKUP_MAX_AGE_MS).state).toBe("ok");
    const past = new Date(edge.getTime() - 1);
    expect(backupState({ latest: { ok: true, finishedAt: past }, lastOkAt: past }, now, BACKUP_MAX_AGE_MS).state).toBe("stale");
  });

  // Propiedad: para cualquier historia de corridas, el estado coincide con el modelo de referencia:
  // none si no hay; failed si la más reciente falló; si no, ok o stale según la edad de la más reciente.
  it("propiedad: coincide con el modelo sobre historias arbitrarias", () => {
    const run = fc.record({ ok: fc.boolean(), offsetMin: fc.integer({ min: 0, max: 60 * 24 * 10 }) });
    fc.assert(
      fc.property(fc.array(run, { maxLength: 20 }), fc.integer({ min: 1, max: 60 * 24 * 5 }), (runs, maxAgeMin) => {
        const dated = runs.map((r) => ({ ok: r.ok, finishedAt: new Date(now.getTime() - r.offsetMin * 60_000) }));
        // Como la consulta de src/db/backup-runs.ts: el más reciente y el último bueno.
        const byTime = [...dated].sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());
        const summary: BackupRunSummary = {
          latest: byTime[0] ?? null,
          lastOkAt: byTime.find((r) => r.ok)?.finishedAt ?? null,
        };
        const s = backupState(summary, now, maxAgeMin * 60_000);
        const newest = byTime[0];
        if (!newest) return s.state === "none";
        if (!newest.ok) return s.state === "failed" && s.failedAt === newest.finishedAt && s.lastOkAt === summary.lastOkAt;
        const age = now.getTime() - newest.finishedAt.getTime();
        return s.state === (age > maxAgeMin * 60_000 ? "stale" : "ok") && "lastOkAt" in s && s.lastOkAt === newest.finishedAt;
      }),
    );
  });
});

describe("wholeDaysBetween", () => {
  it("cuenta días completos y nunca negativo", () => {
    expect(wholeDaysBetween(at("2026-11-08T08:00:00Z"), now)).toBe(3);
    expect(wholeDaysBetween(at("2026-11-11T08:00:00Z"), now)).toBe(0);
    expect(wholeDaysBetween(at("2026-11-12T08:00:00Z"), now)).toBe(0);
  });
});
