import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";

// La migración 0032 (inventario) sobre una base con sedes de antes, como el VPS al desplegar: cada
// sede recibe 1435 y 6135 sin tocar lo que ya había, aplicarla no depende de que existan, y las
// funciones nuevas tienen el search_path fijo.

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const FILE = "0032_inventory.sql";

let client: PGlite;
let upTo0031: string;

function migrationsUpTo0031(): string {
  const dir = mkdtempSync(join(tmpdir(), "villa-0031-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  rmSync(join(dir, FILE));
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 31);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

beforeAll(async () => {
  upTo0031 = migrationsUpTo0031();
  client = new PGlite({ extensions: { btree_gist } });
  await migrate(drizzle({ client, schema }) as never, { migrationsFolder: upTo0031 });
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (upTo0031) rmSync(upTo0031, { recursive: true, force: true });
});

describe("migración 0032 sobre datos de antes", () => {
  it("inserta 1435 y 6135 en las sedes existentes y deja intactas sus cuentas", { timeout: 120_000 }, async () => {
    const { rows } = await client.query<{ id: string }>(`insert into locations (name) values ('Villa vieja') returning id::text`);
    const id = rows[0]!.id;
    await client.query(`insert into accounts (location_id, code, name, type) values ($1, '1105', 'Caja (efectivo)', 'asset')`, [id]);

    await migrate(drizzle({ client, schema }) as never, { migrationsFolder });

    const accounts = await client.query<{ code: string; name: string; type: string }>(`select code, name, type from accounts where location_id = $1 order by code`, [id]);
    expect(accounts.rows).toEqual([
      { code: "1105", name: "Caja (efectivo)", type: "asset" },
      { code: "1435", name: "Inventario de mercancía", type: "asset" },
      // Se migra hasta la última: 0036 (cuentas por pagar) agrega 2205 a las sedes de antes.
      { code: "2205", name: "Proveedores", type: "liability" },
      { code: "6135", name: "Costo de los productos vendidos", type: "expense" },
    ]);

    const noPath = await client.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('ledger_inventory_line_guard', 'inventory_assert_entry_document', 'inventory_documents_assert',
                            'inventory_lines_before_insert', 'products_before_update', 'cash_movements_assert_entry', 'app_apply_grants')
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(noPath.rows).toEqual([]);
  });
});
