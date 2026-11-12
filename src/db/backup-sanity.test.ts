import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromUnits } from "@/domain/money";
import { recordCount, recordPurchase } from "./inventory";
import { paySupplier, reverseSupplierPayment } from "./payables";
import { createProduct } from "./products";
import { key, setupShop } from "./sales-testing";
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

  it("inventario: pasa con compras, una anulación y un conteo; se queja si 1435 no cuadra con los documentos", { timeout: 60_000 }, async () => {
    const shop = await setupShop(t.db, "Cordura inventario");
    const cera = (await createProduct(t.db, { locationId: shop.locationId, draft: { name: "Cera", sku: null, price: fromUnits(30_000n), commissionBps: 0 } })).id;
    const buy = (pesos: bigint) =>
      recordPurchase(t.db, { locationId: shop.locationId, paidFrom: "bank", lines: [{ productId: cera, quantity: 4, amount: fromUnits(pesos) }], idempotencyKey: key("s"), actor: shop.owner });
    await buy(40_000n);
    await recordCount(t.db, { locationId: shop.locationId, lines: [{ productId: cera, quantity: 3 }], idempotencyKey: key("c"), actor: shop.owner });
    await buy(20_000n);
    await t.client.exec(sanity);

    // Un documento que desaparece (restauración parcial o un borrado saltándose los triggers): 1435
    // ya no es el último conteo + las compras.
    // Dentro de una transacción que se deshace: las demás pruebas siguen sobre una base sana.
    await t.client.exec(`BEGIN`);
    await t.client.exec(`SET LOCAL session_replication_role = replica`);
    await t.client.query(
      `delete from inventory_document_lines where location_id = $1 and document_id = (select max(id) from inventory_documents where location_id = $1)`,
      [shop.locationId.toString()],
    );
    await t.client.query(`delete from inventory_documents where id = (select max(id) from inventory_documents where location_id = $1)`, [shop.locationId.toString()]);
    expect(await dbError(t.client.exec(sanity))).toMatch(/inventario \(1435\) no cuadra/);
    await t.client.exec(`ROLLBACK`);
  });

  it("proveedores: pasa con compras a crédito, abonos y un pago anulado; se queja si 2205 no cuadra con las compras y sus pagos", { timeout: 60_000 }, async () => {
    const shop = await setupShop(t.db, "Cordura proveedores");
    const cera = (await createProduct(t.db, { locationId: shop.locationId, draft: { name: "Cera", sku: null, price: fromUnits(30_000n), commissionBps: 0 } })).id;
    const { documentId } = await recordPurchase(t.db, {
      locationId: shop.locationId,
      paidFrom: "credit",
      credit: { supplierName: "Distribuidora Norte", termDays: 30 },
      lines: [{ productId: cera, quantity: 4, amount: fromUnits(80_000n) }],
      idempotencyKey: key("cr"),
      actor: shop.owner,
    });
    const pay = (pesos: bigint) =>
      paySupplier(t.db, { locationId: shop.locationId, documentId, amount: fromUnits(pesos), paidFrom: "bank", idempotencyKey: key("p"), actor: shop.owner });
    await pay(30_000n);
    const { paymentId } = await pay(10_000n);
    await reverseSupplierPayment(t.db, { locationId: shop.locationId, paymentId, actor: shop.owner });
    await t.client.exec(sanity);

    // Un pago que desaparece (restauración parcial o un borrado saltándose los triggers): la deuda del
    // libro ya no es lo que falta de las compras.
    await t.client.exec(`BEGIN`);
    await t.client.exec(`SET LOCAL session_replication_role = replica`);
    await t.client.query(`delete from supplier_payments where location_id = $1 and id = (select min(id) from supplier_payments where location_id = $1)`, [
      shop.locationId.toString(),
    ]);
    expect(await dbError(t.client.exec(sanity))).toMatch(/proveedores \(2205\) no cuadra/);
    await t.client.exec(`ROLLBACK`);
    await t.client.exec(sanity);
  });

  async function currentDb(): Promise<string> {
    const { rows } = await t.client.query<{ d: string }>(`select current_database() as d`);
    return `"${rows[0]!.d}"`;
  }
});
