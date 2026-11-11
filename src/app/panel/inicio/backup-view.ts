import type { BackupStatus } from "@/db/backup-runs";
import { businessDate } from "@/domain/ledger/business-date";
import { type BackupState, wholeDaysBetween } from "@/domain/ops/backup-status";
import { timeLabel } from "@/lib/labels";

// Textos de los respaldos en Inicio del dueño (sprint 9). Aparte de actions.ts ("use server" solo
// exporta acciones) para poder probarlos. Solo fechas y estados: nada de rutas, buckets ni archivos.

export type BackupLine = { kind: "backup" | "restore_test"; tone: "ok" | "alert"; text: string };

type Ctx = { timeZone: string; today: string; now: Date; production: boolean };

/**
 * "hoy a las 03:10" o "el 2026-11-09 a las 03:10", en la zona de la sede. Con "de", contrae:
 * "de hoy a las…" / "del 2026-11-09 a las…".
 */
function when(at: Date, c: Ctx, prep: "" | "de" | "desde" = ""): string {
  const day = businessDate(at, c.timeZone);
  const time = timeLabel(at, c.timeZone);
  if (day === c.today) return `${prep ? `${prep} ` : ""}hoy a las ${time}`;
  return `${prep === "de" ? "del" : prep ? `${prep} el` : "el"} ${day} a las ${time}`;
}

function backupLine(s: BackupState, c: Ctx): BackupLine | null {
  switch (s.state) {
    case "none":
      // En desarrollo no hay backups: no se dice nada. En producción, que no haya ninguno es un problema.
      return c.production ? { kind: "backup", tone: "alert", text: "Todavía no hay ningún respaldo registrado de la base de datos." } : null;
    case "ok":
      return { kind: "backup", tone: "ok", text: `Último respaldo: ${when(s.lastOkAt, c)}` };
    case "failed":
      return {
        kind: "backup",
        tone: "alert",
        text: `El respaldo ${when(s.failedAt, c, "de")} falló. ${s.lastOkAt ? `El último bueno es ${when(s.lastOkAt, c, "de")}.` : "No hay ninguno bueno registrado."}`,
      };
    case "stale": {
      const days = wholeDaysBetween(s.lastOkAt, c.now);
      return {
        kind: "backup",
        tone: "alert",
        text: `No hay respaldo ${when(s.lastOkAt, c, "desde")}${days >= 2 ? ` (hace ${days} días)` : ""}: el respaldo diario no está corriendo.`,
      };
    }
  }
}

function restoreLine(s: BackupState, c: Ctx): BackupLine | null {
  switch (s.state) {
    // La prueba mensual es opcional (necesita la llave privada en el VPS): si nunca corrió, no se dice nada.
    case "none":
      return null;
    case "ok":
      return { kind: "restore_test", tone: "ok", text: `Última prueba de restauración: ${when(s.lastOkAt, c)}` };
    case "failed":
      return { kind: "restore_test", tone: "alert", text: `La prueba de restauración ${when(s.failedAt, c, "de")} falló.` };
    case "stale":
      return { kind: "restore_test", tone: "alert", text: `La última prueba de restauración es ${when(s.lastOkAt, c, "de")}: ya pasó más de un mes.` };
  }
}

/** Las líneas de Inicio: primero el backup diario, luego la prueba mensual. */
export function backupLines(status: BackupStatus, c: Ctx): BackupLine[] {
  return [backupLine(status.backup, c), restoreLine(status.restoreTest, c)].filter((l): l is BackupLine => l !== null);
}
