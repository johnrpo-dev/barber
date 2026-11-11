import { describe, expect, it } from "vitest";
import { backupLines } from "./backup-view";

// Textos de los respaldos en Inicio (sprint 9). Hora de la sede: Bogotá (UTC-5).
const now = new Date("2026-11-11T13:00:00Z"); // 8:00 a. m.
const ctx = { timeZone: "America/Bogota", today: "2026-11-11", now, production: true };
const none = { state: "none" } as const;

describe("backupLines", () => {
  it("el de esta madrugada bien y la prueba del mes: dos líneas tranquilas, con la hora local", () => {
    const lines = backupLines(
      {
        backup: { state: "ok", lastOkAt: new Date("2026-11-11T08:10:00Z") },
        restoreTest: { state: "ok", lastOkAt: new Date("2026-11-02T09:00:00Z") },
      },
      ctx,
    );
    expect(lines).toEqual([
      { kind: "backup", tone: "ok", text: "Último respaldo: hoy a las 03:10" },
      { kind: "restore_test", tone: "ok", text: "Última prueba de restauración: el 2026-11-02 a las 04:00" },
    ]);
  });

  it("falló: lo dice con el último bueno (con 'del', no 'de el')", () => {
    const [line] = backupLines(
      { backup: { state: "failed", failedAt: new Date("2026-11-11T08:10:00Z"), lastOkAt: new Date("2026-11-10T08:10:00Z") }, restoreTest: none },
      ctx,
    );
    expect(line).toEqual({
      kind: "backup",
      tone: "alert",
      text: "El respaldo de hoy a las 03:10 falló. El último bueno es del 2026-11-10 a las 03:10.",
    });
  });

  it("falló sin ninguno bueno antes", () => {
    const [line] = backupLines({ backup: { state: "failed", failedAt: new Date("2026-11-10T08:10:00Z"), lastOkAt: null }, restoreTest: none }, ctx);
    expect(line?.text).toBe("El respaldo del 2026-11-10 a las 03:10 falló. No hay ninguno bueno registrado.");
  });

  it("dejó de correr: cuántos días van", () => {
    const [line] = backupLines({ backup: { state: "stale", lastOkAt: new Date("2026-11-08T08:10:00Z") }, restoreTest: none }, ctx);
    expect(line).toEqual({
      kind: "backup",
      tone: "alert",
      text: "No hay respaldo desde el 2026-11-08 a las 03:10 (hace 3 días): el respaldo diario no está corriendo.",
    });
  });

  it("sin ningún respaldo: en producción avisa; en desarrollo no dice nada", () => {
    expect(backupLines({ backup: none, restoreTest: none }, ctx)).toEqual([
      { kind: "backup", tone: "alert", text: "Todavía no hay ningún respaldo registrado de la base de datos." },
    ]);
    expect(backupLines({ backup: none, restoreTest: none }, { ...ctx, production: false })).toEqual([]);
  });

  it("la prueba de restauración vieja o fallida avisa; si nunca corrió, no se menciona", () => {
    const ok = { state: "ok", lastOkAt: new Date("2026-11-11T08:10:00Z") } as const;
    expect(backupLines({ backup: ok, restoreTest: { state: "stale", lastOkAt: new Date("2026-09-20T09:00:00Z") } }, ctx)[1]).toEqual({
      kind: "restore_test",
      tone: "alert",
      text: "La última prueba de restauración es del 2026-09-20 a las 04:00: ya pasó más de un mes.",
    });
    expect(backupLines({ backup: ok, restoreTest: { state: "failed", failedAt: new Date("2026-11-01T09:00:00Z"), lastOkAt: null } }, ctx)[1]?.text).toBe(
      "La prueba de restauración del 2026-11-01 a las 04:00 falló.",
    );
    expect(backupLines({ backup: ok, restoreTest: none }, ctx)).toHaveLength(1);
  });
});
