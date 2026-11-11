// Estado de los respaldos para Inicio del dueño (sprint 9, docs/00-descubrimiento.md §12.1).
// Puro: recibe el último resultado y el último bueno de cada tipo (los lee src/db/backup-runs.ts
// de la tabla backup_runs, que escriben los scripts del VPS) y decide qué mostrar.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** El backup corre cada noche: más de 26 h sin uno bueno es que anoche no salió (2 h de margen). */
export const BACKUP_MAX_AGE_MS = 26 * HOUR_MS;
/** La prueba de restauración es mensual: más de 40 días sin una buena, se avisa. */
export const RESTORE_TEST_MAX_AGE_MS = 40 * DAY_MS;

export type BackupKind = "backup" | "restore_test";

export interface BackupRunSummary {
  /** El resultado más reciente, bueno o malo. */
  latest: { ok: boolean; finishedAt: Date } | null;
  /** Cuándo terminó el último bueno. */
  lastOkAt: Date | null;
}

export type BackupState =
  /** Nunca se registró uno (desarrollo, o el VPS aún sin backups). */
  | { state: "none" }
  | { state: "ok"; lastOkAt: Date }
  /** El más reciente falló. `lastOkAt`: el último bueno, si hubo. */
  | { state: "failed"; failedAt: Date; lastOkAt: Date | null }
  /** El más reciente salió bien, pero hace demasiado: dejó de correr. */
  | { state: "stale"; lastOkAt: Date };

/**
 * Qué decir de un tipo de respaldo. Una falla manda aunque haya uno bueno reciente: el dueño debe
 * saber que anoche no salió. Si después se repite y sale bien, lo más reciente es bueno y vuelve a ok.
 */
export function backupState(summary: BackupRunSummary, now: Date, maxAgeMs: number): BackupState {
  const { latest, lastOkAt } = summary;
  if (latest === null) return { state: "none" };
  if (!latest.ok) return { state: "failed", failedAt: latest.finishedAt, lastOkAt };
  // latest.ok: el último bueno es él mismo (lastOkAt solo puede ser igual o, con datos raros, null).
  const okAt = lastOkAt ?? latest.finishedAt;
  return now.getTime() - okAt.getTime() > maxAgeMs ? { state: "stale", lastOkAt: okAt } : { state: "ok", lastOkAt: okAt };
}

/** Días completos entre dos instantes (para "hace 3 días"). */
export function wholeDaysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}
