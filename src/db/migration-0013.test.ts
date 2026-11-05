import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromUnits } from "@/domain/money";
import { tipPayoutEntry } from "@/domain/sales/cash";
import { openCashSession } from "./cash";
import { createLocation, postEntry, reverseEntry, trialBalance } from "./ledger";
import { key, quickSale, setupShop } from "./sales-testing";
import * as schema from "./schema";
import { sql } from "drizzle-orm";
import type { Db } from "./types";
import { rowsOf } from "./sql";
import { requestVoid } from "./voids";

// La migración 0013 sobre una base con sedes de antes (como el VPS al desplegar): cada sede recibe
// la cuenta 1365 sin tocar nada de lo que ya había, y las funciones nuevas tienen el search_path fijo.

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const FILE = "0013_commissions_reports.sql";

let client: PGlite;
let upTo0012: string;

/** Copia de las migraciones hasta 0012, con su journal recortado. */
function migrationsUpTo0012(): string {
  const dir = mkdtempSync(join(tmpdir(), "villa-0012-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  rmSync(join(dir, FILE));
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 12);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

beforeAll(async () => {
  upTo0012 = migrationsUpTo0012();
  client = new PGlite({ extensions: { btree_gist } });
  await migrate(drizzle({ client, schema }) as never, { migrationsFolder: upTo0012 });
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (upTo0012) rmSync(upTo0012, { recursive: true, force: true });
});

describe("migración 0013 sobre datos de antes", () => {
  it("inserta 1365 en las sedes existentes, deja intactas sus cuentas y fija el search_path", { timeout: 120_000 }, async () => {
    const { rows } = await client.query<{ id: string }>(`insert into locations (name) values ('Villa vieja') returning id::text`);
    const id = rows[0]!.id;
    await client.query(`insert into accounts (location_id, code, name, type) values ($1, '1105', 'Caja (efectivo)', 'asset')`, [id]);
    expect(readdirSync(migrationsFolder)).toContain(FILE);

    await migrate(drizzle({ client, schema }) as never, { migrationsFolder });

    const accounts = await client.query<{ code: string; name: string; type: string }>(`select code, name, type from accounts where location_id = $1 order by code`, [id]);
    expect(accounts.rows).toEqual([
      { code: "1105", name: "Caja (efectivo)", type: "asset" },
      { code: "1365", name: "Cuentas por cobrar a trabajadores (anticipos)", type: "asset" },
    ]);

    const noPath = await client.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('staff_commission_owed', 'staff_tips_owed', 'staff_receivable', 'app_apply_grants', 'commission_settlements_assert', 'staff_advances_assert')
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(noPath.rows).toEqual([]);

    // Sin nada todavía, los saldos son cero y no fallan.
    const balances = await client.query<{ commission: string; tips: string; receivable: string }>(
      `insert into staff_members (location_id, display_name, role) values ($1, 'Andrés', 'barber')
       returning staff_commission_owed(location_id, id)::text as commission, staff_tips_owed(location_id, id)::text as tips, staff_receivable(location_id, id)::text as receivable`,
      [id],
    );
    expect(balances.rows[0]).toEqual({ commission: "0", tips: "0", receivable: "0" });
  });
});

// Antes de 0013 no existe la bitácora: un cobro de hoy la escribe. Esta tabla de paso solo vive
// mientras se siembran los datos viejos; se borra antes de migrar (0013 crea la de verdad).
const AUDIT_STUB = `create table audit_events (id bigint generated always as identity primary key, location_id bigint, occurred_at timestamptz default now(),
  actor_user_id text, actor_staff_id bigint, action text, category text, target_kind text, target_ref text, summary text, changes jsonb)`;

/**
 * Columnas de migraciones posteriores a 0013 que el esquema de hoy escribe al insertar (p. ej.
 * createLocation). Se agregan sobre la base en 0012 para usar las funciones de hoy, y se quitan
 * antes de migrar para que cada migración las cree como en el VPS.
 */
const LATER_COLUMNS_STUB = `alter table locations add column tax_id text, add column receipt_footer text`;
const DROP_LATER_COLUMNS = `alter table locations drop column tax_id, drop column receipt_footer`;
/** staff_services (0019): las funciones de hoy asignan servicios al crear personas y servicios. */
const LATER_TABLES_STUB = `create table staff_services (location_id bigint not null, staff_id bigint not null, service_id bigint not null,
  created_at timestamptz not null default now(), primary key (location_id, staff_id, service_id))`;
const DROP_LATER_TABLES = `drop table staff_services`;

describe("saldos sobre datos de antes de 0013", () => {
  it("las ventas, la anulación y el pago de propinas viejos quedan pendientes e iguales a 2335 y 2380", { timeout: 180_000 }, async () => {
    const old = new PGlite({ extensions: { btree_gist } });
    try {
      const orm = drizzle({ client: old, schema });
      await migrate(orm as never, { migrationsFolder: upTo0012 });
      const db = orm as unknown as Db;
      await old.exec(AUDIT_STUB);
      await old.exec(LATER_COLUMNS_STUB);
      await old.exec(LATER_TABLES_STUB);

      const shop = await setupShop(db, "Villa vieja");
      await openCashSession(db, { locationId: shop.locationId, counted: fromUnits(0n), idempotencyKey: key("open"), actor: shop.owner });
      await quickSale(db, shop, { kind: "cash", tip: 5_000n });
      await quickSale(db, shop, { kind: "card" });
      const { saleId } = await quickSale(db, shop, { kind: "cash", tip: 1_000n });

      // La anulación y el pago, a mano: las funciones de hoy ya consultan tablas de 0013.
      const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Se cobró dos veces", idempotencyKey: key("void"), actor: shop.reception });
      await db.transaction(async (tx) => {
        const conn = tx as unknown as Db;
        // Dentro de la transacción, por su misma conexión: PGlite tiene una sola y otra consulta esperaría para siempre.
        const found = await conn.execute(
          sql`select s.journal_entry_id::text as entry, s.business_date::text as day, (select id::text from cash_sessions where location_id = s.location_id and closed_at is null) as session from sales s where s.id = ${saleId}`,
        );
        const sale = rowsOf<{ entry: string; day: string; session: string }>(found)[0]!;
        const reversal = await reverseEntry(conn, { locationId: shop.locationId, entryId: BigInt(sale.entry), businessDate: sale.day, reason: "Anulación", createdBy: "x" });
        await conn.execute(sql`update sales set status = 'voided', void_entry_id = ${reversal.entryId}, voided_at = now() where id = ${saleId}`);
        await conn.execute(sql`update void_requests set status = 'approved', decided_by = 'x', decided_at = now(), decision_idempotency_key = ${key("d")}, decision_request_hash = ${"a".repeat(64)} where id = ${requestId}`);
        await conn.execute(
          sql`insert into cash_movements (location_id, cash_session_id, kind, journal_entry_id, description, created_by) values (${shop.locationId}, ${BigInt(sale.session)}, 'reversal', ${reversal.entryId}, 'Anulación', 'x')`,
        );
        const paid = await postEntry(conn, {
          locationId: shop.locationId,
          createdBy: "x",
          entry: tipPayoutEntry(fromUnits(2_000n), { businessDate: sale.day, memo: "Propinas a Andrés", idempotencyKey: key("tips") }),
        });
        await conn.execute(
          sql`insert into cash_movements (location_id, cash_session_id, kind, journal_entry_id, staff_id, description, created_by) values (${shop.locationId}, ${BigInt(sale.session)}, 'tip_payout', ${paid.entryId}, ${shop.barber}, 'Propinas a Andrés', 'x')`,
        );
      });

      await old.exec("drop table audit_events");
      await old.exec(DROP_LATER_COLUMNS);
      await old.exec(DROP_LATER_TABLES);
      await migrate(orm as never, { migrationsFolder });

      const { rows: balances } = await old.query<{ commission: string; tips: string; receivable: string }>(
        `select staff_commission_owed($1, $2)::text as commission, staff_tips_owed($1, $2)::text as tips, staff_receivable($1, $2)::text as receivable`,
        [String(shop.locationId), String(shop.barber)],
      );
      // Dos ventas vigentes al 40 % de $30.000; $5.000 de propina menos $2.000 ya pagados.
      expect(balances[0]).toEqual({ commission: fromUnits(24_000n).minor.toString(), tips: fromUnits(3_000n).minor.toString(), receivable: "0" });

      const trial = await trialBalance(db, { locationId: shop.locationId });
      const net = (code: string) => {
        const r = trial.find((x) => x.code === code);
        return r ? r.credits - r.debits : 0n;
      };
      expect(net("2335")).toBe(fromUnits(24_000n).minor);
      expect(net("2380")).toBe(fromUnits(3_000n).minor);
    } finally {
      await old.close();
    }
  });

  it("no migra si ya hay asientos commission_payout", { timeout: 180_000 }, async () => {
    const old = new PGlite({ extensions: { btree_gist } });
    try {
      const orm = drizzle({ client: old, schema });
      await migrate(orm as never, { migrationsFolder: upTo0012 });
      const db = orm as unknown as Db;
      await old.exec(LATER_COLUMNS_STUB);
      const locationId = await createLocation(db, { name: "Villa vieja" });
      await postEntry(db, {
        locationId,
        createdBy: "x",
        entry: {
          businessDate: "2026-01-01",
          kind: "commission_payout",
          memo: "Pago por fuera",
          idempotencyKey: key("pago"),
          lines: [
            { account: "2335", side: "debit", amount: fromUnits(1_000n) },
            { account: "1110", side: "credit", amount: fromUnits(1_000n) },
          ],
        },
      });
      // Sin las columnas de después: si fallara, que sea por la guarda de 0013 y no por 0014.
      await old.exec(DROP_LATER_COLUMNS);
      await expect(migrate(orm as never, { migrationsFolder })).rejects.toThrow(/commission_payout|Failed query/);
      const { rows: tables } = await old.query<{ n: string }>(`select count(*)::text as n from information_schema.tables where table_name = 'audit_events'`);
      expect(tables[0]!.n).toBe("0");
    } finally {
      await old.close();
    }
  });
});
