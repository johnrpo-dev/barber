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

// La migración 0019 sobre una base con personal y servicios de antes (como el VPS al desplegar):
// todo el personal queda haciendo todos los servicios de su sede, así nada deja de ofrecerse.

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const FILE = "0019_staff_services.sql";

let client: PGlite;
let upTo0018: string;

function migrationsUpTo0018(): string {
  const dir = mkdtempSync(join(tmpdir(), "villa-0018-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  rmSync(join(dir, FILE));
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 18);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

beforeAll(async () => {
  upTo0018 = migrationsUpTo0018();
  client = new PGlite({ extensions: { btree_gist } });
  await migrate(drizzle({ client, schema }) as never, { migrationsFolder: upTo0018 });
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (upTo0018) rmSync(upTo0018, { recursive: true, force: true });
});

describe("migración 0019 sobre datos de antes", () => {
  it("asigna a cada persona todos los servicios de su sede, sin cruzar sedes", { timeout: 120_000 }, async () => {
    const loc = async (name: string) => (await client.query<{ id: string }>(`insert into locations (name) values ($1) returning id::text`, [name])).rows[0]!.id;
    const a = await loc("Villa");
    const b = await loc("Otra");
    for (const [l, n] of [[a, "Andrés"], [a, "Bruno"], [b, "Carlos"]] as const) {
      await client.query(`insert into staff_members (location_id, display_name, role) values ($1, $2, 'barber')`, [l, n]);
    }
    for (const [l, n] of [[a, "Corte"], [a, "Barba"], [b, "Corte"]] as const) {
      await client.query(`insert into services (location_id, name, duration_min, price, commission_bps) values ($1, $2, 30, 3000000, 5000)`, [l, n]);
    }

    await migrate(drizzle({ client, schema }) as never, { migrationsFolder });

    const rows = await client.query<{ loc: string; staff: string; service: string }>(
      `select ss.location_id::text as loc, m.display_name as staff, s.name as service
         from staff_services ss
         join staff_members m on m.location_id = ss.location_id and m.id = ss.staff_id
         join services s on s.location_id = ss.location_id and s.id = ss.service_id
        order by ss.location_id, m.display_name, s.name`,
    );
    expect(rows.rows).toEqual([
      { loc: a, staff: "Andrés", service: "Barba" },
      { loc: a, staff: "Andrés", service: "Corte" },
      { loc: a, staff: "Bruno", service: "Barba" },
      { loc: a, staff: "Bruno", service: "Corte" },
      { loc: b, staff: "Carlos", service: "Corte" },
    ]);
  });
});
