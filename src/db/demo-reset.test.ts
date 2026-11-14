import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { findOrCreateClient } from "./clients";
import { DemoResetError, demoResetEnabled, RESET_KEEP, RESET_WIPE, resetDemoData } from "./demo-reset";
import { backupRuns } from "./schema";
import { quickSale, setupShop } from "./sales-testing";
import { rowsOf } from "./sql";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

// "Empezar de cero" en la base de la demo: vacía la operación, conserva la configuración y se niega en
// cualquier base que no sea la de práctica. PGlite corre como superusuario sobre la base "postgres".

const PGLITE_DB = "postgres";

async function count(db: Db, table: string): Promise<number> {
  const [row] = rowsOf<{ n: number }>(await db.execute(sql.raw(`select count(*)::int as n from public."${table}"`)));
  return Number(row?.n ?? 0);
}

describe("borrado de la base de la demo", { timeout: 60_000 }, () => {
  it("cada tabla del esquema está clasificada una sola vez (conservar o vaciar)", async () => {
    const { db } = await createTestDb();
    const tables = rowsOf<{ name: string }>(
      await db.execute(sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`),
    )
      .map((t) => t.name)
      .sort();
    const classified = [...RESET_KEEP, ...RESET_WIPE].sort();
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified).toEqual(tables);
  });

  it("ninguna tabla que se conserva apunta a una que se vacía (el TRUNCATE no arrastra configuración)", async () => {
    const { db } = await createTestDb();
    const fks = rowsOf<{ child: string; parent: string }>(
      await db.execute(sql`
        select conrelid::regclass::text as child, confrelid::regclass::text as parent
          from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`),
    );
    const keep = new Set<string>(RESET_KEEP);
    const wipe = new Set<string>(RESET_WIPE);
    const bad = fks.map((f) => ({ child: f.child.replaceAll('"', ""), parent: f.parent.replaceAll('"', "") })).filter((f) => keep.has(f.child) && wipe.has(f.parent));
    expect(bad).toEqual([]);
  });

  it("vacía ventas, libro y clientes; conserva servicios, personal y medios de pago; se puede volver a cobrar", async () => {
    const { db } = await createTestDb();
    const shop = await setupShop(db);
    await quickSale(db, shop);
    await quickSale(db, shop);
    expect(await count(db, "journal_entries")).toBeGreaterThan(0);
    const before = { services: await count(db, "services"), staff: await count(db, "staff_members"), methods: await count(db, "payment_methods") };

    const r = await resetDemoData(db, { databaseName: PGLITE_DB });
    expect(r.tables).toBe(RESET_WIPE.length);
    for (const t of ["sales", "sale_lines", "journal_entries", "journal_lines", "appointments", "appointment_events", "clients", "audit_events"]) {
      expect(await count(db, t), t).toBe(0);
    }
    expect(await count(db, "services")).toBe(before.services);
    expect(await count(db, "staff_members")).toBe(before.staff);
    expect(await count(db, "payment_methods")).toBe(before.methods);

    // Los triggers de producción siguen puestos: fuera del borrado, el libro sigue siendo intocable.
    expect(await dbError(db.execute(sql`truncate table journal_entries`))).toMatch(/./);

    // Y la base sigue operando: un cobro nuevo cuadra como siempre.
    const client = (await findOrCreateClient(db, { locationId: shop.locationId, name: "Cliente nuevo", phone: "300 765 4321" })).id;
    const { saleId } = await quickSale(db, { ...shop, client });
    expect(saleId).toBeGreaterThan(0n);
  });

  it("se niega si la base no es la de la demo, y no borra nada", async () => {
    const { db } = await createTestDb();
    const shop = await setupShop(db);
    await quickSale(db, shop);
    await expect(resetDemoData(db)).rejects.toThrow(DemoResetError);
    expect(await count(db, "sales")).toBe(1);
  });

  it("se niega si la base tiene respaldos registrados (la de la barbería)", async () => {
    const { db } = await createTestDb();
    const shop = await setupShop(db);
    await quickSale(db, shop);
    await db.insert(backupRuns).values({ kind: "backup", ok: true });
    await expect(resetDemoData(db, { databaseName: PGLITE_DB })).rejects.toThrow(/respaldos/);
    expect(await count(db, "sales")).toBe(1);
  });

  it("se niega con el rol de la app en producción (villa_app no es superusuario)", async () => {
    const { db } = await createTestDb({ role: "app" });
    await expect(resetDemoData(db, { databaseName: PGLITE_DB })).rejects.toThrow(DemoResetError);
  });

  it("el botón solo existe con VILLA_DEMO=1", () => {
    expect(demoResetEnabled({ VILLA_DEMO: "1" })).toBe(true);
    expect(demoResetEnabled({})).toBe(false);
    expect(demoResetEnabled({ VILLA_DEMO: "true" })).toBe(false);
    expect(demoResetEnabled({ VILLA_DEMO: "0" })).toBe(false);
  });
});
