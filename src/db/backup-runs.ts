import { sql } from "drizzle-orm";
import {
  BACKUP_MAX_AGE_MS,
  type BackupKind,
  type BackupRunSummary,
  type BackupState,
  backupState,
  RESTORE_TEST_MAX_AGE_MS,
} from "@/domain/ops/backup-status";
import { backupRuns } from "./schema";
import type { Db } from "./types";

// Respaldos (migración 0031). Los registran los scripts del VPS (deploy/backup) como postgres; la app
// solo lee. Una consulta agrupada por tipo: el resultado más reciente y el último bueno. Pocas filas
// (una por noche y una por mes), así que no hace falta más.

const toDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

/** El más reciente y el último bueno de cada tipo, en SQL. */
export async function backupSummaries(db: Db): Promise<Record<BackupKind, BackupRunSummary>> {
  const rows = await db
    .select({
      kind: backupRuns.kind,
      // Desempate por id: dos filas con la misma hora toman la última insertada.
      latestOk: sql<boolean>`(array_agg(${backupRuns.ok} order by ${backupRuns.finishedAt} desc, ${backupRuns.id} desc))[1]`,
      latestAt: sql<Date | string>`max(${backupRuns.finishedAt})`,
      lastOkAt: sql<Date | string | null>`max(${backupRuns.finishedAt}) filter (where ${backupRuns.ok})`,
    })
    .from(backupRuns)
    .groupBy(backupRuns.kind);
  const out: Record<BackupKind, BackupRunSummary> = {
    backup: { latest: null, lastOkAt: null },
    restore_test: { latest: null, lastOkAt: null },
  };
  for (const r of rows) {
    out[r.kind] = { latest: { ok: r.latestOk === true, finishedAt: toDate(r.latestAt)! }, lastOkAt: toDate(r.lastOkAt) };
  }
  return out;
}

export interface BackupStatus {
  backup: BackupState;
  restoreTest: BackupState;
}

/** Estado del backup diario y de la prueba mensual de restauración, para Inicio del dueño. */
export async function backupStatus(db: Db, now: Date = new Date()): Promise<BackupStatus> {
  const s = await backupSummaries(db);
  return {
    backup: backupState(s.backup, now, BACKUP_MAX_AGE_MS),
    restoreTest: backupState(s.restore_test, now, RESTORE_TEST_MAX_AGE_MS),
  };
}
