import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { backupStatus, backupSummaries } from "./backup-runs";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

// Respaldos (0031). La sesión es de administrador, como postgres en el VPS (los scripts de
// deploy/backup escriben así); las lecturas van como villa_app con SET ROLE. backup_runs es
// solo-inserción para todos, así que cada caso corre en una transacción que se deshace al final
// (una sola base para el archivo: crear una por caso tarda demasiado con toda la suite corriendo).

let db: Db;
let client: PGlite;
const now = new Date("2026-11-11T13:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

/** Como los scripts: INSERT directo como postgres. */
async function run(kind: "backup" | "restore_test", ok: boolean, finishedAt: string, detail: string | null = null) {
  await client.query("INSERT INTO backup_runs (kind, ok, finished_at, detail) VALUES ($1, $2, $3, $4)", [kind, ok, finishedAt, detail]);
}

async function asApp<T>(fn: () => Promise<T>): Promise<T> {
  await client.exec("SET ROLE villa_app");
  try {
    return await fn();
  } finally {
    await client.exec("RESET ROLE");
  }
}

/** Una sentencia que debe fallar, sin abortar la transacción del caso: el mensaje del error. */
async function failing(text: string, params: unknown[] = [], opts: { asApp?: boolean } = {}): Promise<string> {
  await client.exec("SAVEPOINT attempt");
  if (opts.asApp) await client.exec("SET ROLE villa_app");
  const message = await dbError(client.query(text, params));
  // Deshace también el SET ROLE (es transaccional).
  await client.exec("ROLLBACK TO SAVEPOINT attempt");
  return message;
}

beforeAll(async () => {
  ({ db, client } = await createTestDb({ role: "app", keepAdminSession: true }));
}, 60_000);
beforeEach(async () => client.exec("BEGIN"));
afterEach(async () => client.exec("ROLLBACK"));
afterAll(async () => client?.close());

describe("backupStatus", () => {
  it("sin registros: none en los dos", async () => {
    expect(await asApp(() => backupStatus(db, now))).toEqual({ backup: { state: "none" }, restoreTest: { state: "none" } });
  });

  it("el de anoche bien: ok; la prueba de restauración de hace 10 días: ok", async () => {
    await run("backup", true, hoursAgo(30));
    await run("backup", true, hoursAgo(5));
    await run("restore_test", true, hoursAgo(240));
    const s = await asApp(() => backupStatus(db, now));
    expect(s.backup).toEqual({ state: "ok", lastOkAt: new Date(hoursAgo(5)) });
    expect(s.restoreTest).toEqual({ state: "ok", lastOkAt: new Date(hoursAgo(240)) });
  });

  it("el de anoche falló: failed con el último bueno, aunque haya uno bueno de hace 29 h", async () => {
    await run("backup", true, hoursAgo(29));
    await run("backup", false, hoursAgo(5), "villa-backup.service");
    expect((await asApp(() => backupStatus(db, now))).backup).toEqual({
      state: "failed",
      failedAt: new Date(hoursAgo(5)),
      lastOkAt: new Date(hoursAgo(29)),
    });
  });

  it("dejó de correr: stale si el último bueno tiene más de 26 h", async () => {
    await run("backup", true, hoursAgo(50));
    expect((await asApp(() => backupStatus(db, now))).backup.state).toBe("stale");
  });

  it("la prueba de restauración falló: failed, sin tocar el estado del backup", async () => {
    await run("backup", true, hoursAgo(3));
    await run("restore_test", false, hoursAgo(2), "villa-restore-test.service");
    const s = await asApp(() => backupStatus(db, now));
    expect(s.backup.state).toBe("ok");
    expect(s.restoreTest).toEqual({ state: "failed", failedAt: new Date(hoursAgo(2)), lastOkAt: null });
  });

  it("misma hora: manda la última insertada", async () => {
    const t = hoursAgo(4);
    await run("backup", false, t);
    await run("backup", true, t);
    expect((await asApp(() => backupSummaries(db))).backup.latest?.ok).toBe(true);
  });
});

describe("permisos y solo-inserción", () => {
  it("villa_app lee pero no puede registrar un respaldo (no puede fingir uno) ni usar su secuencia", async () => {
    expect(await failing("INSERT INTO backup_runs (kind, ok) VALUES ('backup', true)", [], { asApp: true })).toMatch(/permission denied/i);
    expect(await failing("SELECT nextval('backup_runs_id_seq')", [], { asApp: true })).toMatch(/permission denied/i);
  });

  it("nadie lo cambia ni lo borra, ni siquiera el administrador", async () => {
    await run("backup", false, hoursAgo(5));
    expect(await failing("UPDATE backup_runs SET ok = true")).not.toBe("");
    expect(await failing("DELETE FROM backup_runs")).not.toBe("");
    expect(await failing("TRUNCATE backup_runs")).not.toBe("");
    expect(await failing("UPDATE backup_runs SET ok = true", [], { asApp: true })).toMatch(/permission denied/i);
  });

  it("valida el tipo, el tamaño y el largo de la nota", async () => {
    expect(await failing("INSERT INTO backup_runs (kind, ok) VALUES ('otro', true)")).toMatch(/backup_runs_kind_check/);
    expect(await failing("INSERT INTO backup_runs (kind, ok, size_bytes) VALUES ('backup', true, -1)")).toMatch(/backup_runs_size_check/);
    expect(await failing("INSERT INTO backup_runs (kind, ok, detail) VALUES ('backup', true, $1)", ["x".repeat(201)])).toMatch(/backup_runs_detail_check/);
  });
});
