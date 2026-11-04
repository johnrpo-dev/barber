import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, dbError } from "./testing";

// deploy/backup/sanity.sql revisa un backup restaurado. Se corre aquí sobre una base con todas las
// migraciones, sin los comandos propios de psql (\echo, \set, \pset), que PGlite no entiende.
const sanity = readFileSync(resolve(process.cwd(), "deploy/backup/sanity.sql"), "utf8")
  .split(/\r?\n/)
  .filter((line) => !line.startsWith("\\"))
  .join("\n");

describe("sanity.sql (prueba de restauración)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    t = await createTestDb({ role: "app", keepAdminSession: true });
  }, 120_000);

  afterAll(async () => {
    await t.client.close();
  });

  it("pasa en una base con las migraciones y los permisos de la app", async () => {
    await t.client.exec(sanity);
  });

  it("se queja si villa_app puede editar el libro", async () => {
    await t.client.exec(`GRANT UPDATE ON journal_entries TO villa_app`);
    expect(await dbError(t.client.exec(sanity))).toMatch(/villa_app puede editar o borrar journal_entries/);
    await t.client.exec(`REVOKE UPDATE ON journal_entries FROM villa_app`);
  });

  it("se queja si falta un trigger o está apagado", async () => {
    await t.client.exec(`ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_balanced`);
    expect(await dbError(t.client.exec(sanity))).toMatch(/journal_lines_balanced/);
    await t.client.exec(`ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_balanced`);
  });

  it("se queja si villa_app puede crear tablas temporales", async () => {
    await t.client.exec(`GRANT TEMPORARY ON DATABASE ${await currentDb()} TO villa_app`);
    expect(await dbError(t.client.exec(sanity))).toMatch(/tablas temporales/);
    await t.client.exec(`REVOKE TEMPORARY ON DATABASE ${await currentDb()} FROM villa_app`);
  });

  async function currentDb(): Promise<string> {
    const { rows } = await t.client.query<{ d: string }>(`select current_database() as d`);
    return `"${rows[0]!.d}"`;
  }
});
