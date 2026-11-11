import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { InventoryError } from "@/domain/inventory/product";
import { fromUnits, type Money, money } from "@/domain/money";
import { CashError } from "@/domain/sales/cash";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import { openCashSession } from "./cash";
import { inventoryBalance, recordCount, recordPurchase } from "./inventory";
import { accountBalance, closeDay, postEntry, reverseEntry, trialBalance } from "./ledger";
import { createProduct, lastPurchases, listProducts, setProductActive, updateProduct } from "./products";
import { key, type Shop, setupShop, TZ } from "./sales-testing";
import { auditEvents, cashMovements, inventoryDocumentLines, inventoryDocuments } from "./schema";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

// Inventario periódico (sprint 6, migración 0032): compras de caja, banco y carga inicial; conteo con
// ajuste contra 6135; y lo que la base garantiza aunque alguien se salte la capa de TypeScript.

let db: Db;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await client?.close();
});

const cop = (pesos: bigint): Money => fromUnits(pesos);
const today = () => businessDate(new Date(), TZ);

async function product(shop: Shop, name: string, price = 30_000n): Promise<bigint> {
  return (await createProduct(db, { locationId: shop.locationId, draft: { name, sku: null, price: cop(price), commissionBps: 0 } })).id;
}

async function openDrawer(shop: Shop, pesos = 200_000n) {
  await openCashSession(db, { locationId: shop.locationId, counted: cop(pesos), note: "Base de prueba", idempotencyKey: key("open"), actor: shop.owner });
  // La base sale del capital del dueño solo si el libro no tenía efectivo: aquí se fondea la caja.
  if ((await accountBalance(db, shop.locationId, ACCOUNTS.cash.code)) < cop(pesos).minor) {
    await postEntry(db, {
      locationId: shop.locationId,
      createdBy: shop.owner.userId,
      entry: {
        kind: "owner_contribution",
        businessDate: today(),
        memo: "Base de la caja",
        lines: [
          { account: ACCOUNTS.cash.code, side: "debit", amount: cop(pesos) },
          { account: ACCOUNTS.ownerEquity.code, side: "credit", amount: cop(pesos) },
        ],
      },
    });
  }
}

const balance = (shop: Shop, code: (typeof ACCOUNTS)[keyof typeof ACCOUNTS]["code"]) => accountBalance(db, shop.locationId, code);

describe("cuentas del inventario", () => {
  it("una sede nueva tiene 1435 (activo) y 6135 (gasto)", async () => {
    const shop = await setupShop(db, "Cuentas inventario");
    const { rows } = await client.query<{ code: string; type: string }>(`select code, type from accounts where location_id = $1 and code in ('1435', '6135') order by code`, [
      shop.locationId.toString(),
    ]);
    expect(rows).toEqual([
      { code: "1435", type: "asset" },
      { code: "6135", type: "expense" },
    ]);
  });
});

describe("compra de mercancía", () => {
  it("de caja: Dr 1435 / Cr 1105, movimiento del turno, líneas y bitácora; repetir devuelve la misma", async () => {
    const shop = await setupShop(db, "Compra caja");
    const cera = await product(shop, "Cera mate");
    const aceite = await product(shop, "Aceite para barba");
    await openDrawer(shop);
    const input = {
      locationId: shop.locationId,
      paidFrom: "cash" as const,
      lines: [
        { productId: aceite, quantity: 3, amount: cop(45_000n) },
        { productId: cera, quantity: 2, amount: cop(20_000n) },
      ],
      note: "Proveedor del barrio",
      idempotencyKey: key("buy"),
      actor: shop.reception,
    };
    const cashBefore = await balance(shop, ACCOUNTS.cash.code);
    const first = await recordPurchase(db, input);
    expect(first).toMatchObject({ created: true, total: cop(65_000n) });
    expect(await balance(shop, ACCOUNTS.inventory.code)).toBe(cop(65_000n).minor);
    expect(await balance(shop, ACCOUNTS.cash.code)).toBe(cashBefore - cop(65_000n).minor);

    // Mismo contenido en otro orden: la misma compra.
    const again = await recordPurchase(db, { ...input, lines: [...input.lines].reverse() });
    expect(again).toMatchObject({ documentId: first.documentId, created: false });
    expect(await balance(shop, ACCOUNTS.inventory.code)).toBe(cop(65_000n).minor);

    // Misma clave con otro contenido: conflicto.
    await expect(recordPurchase(db, { ...input, lines: [{ productId: cera, quantity: 2, amount: cop(21_000n) }] })).rejects.toThrow(IdempotencyConflictError);

    const moves = await db.select().from(cashMovements).where(and(eq(cashMovements.locationId, shop.locationId), eq(cashMovements.kind, "inventory_purchase")));
    expect(moves).toHaveLength(1);
    const lines = await db.select().from(inventoryDocumentLines).where(eq(inventoryDocumentLines.documentId, first.documentId));
    expect(lines.map((l) => l.amount).sort()).toEqual([cop(20_000n).minor, cop(45_000n).minor].sort());
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.locationId, shop.locationId), eq(auditEvents.action, "inventory.purchase")));
    expect(audit).toHaveLength(1);

    const last = await lastPurchases(db, shop.locationId);
    expect(last.get(aceite)).toEqual({ quantity: 3, amount: cop(45_000n) });
  });

  it("del banco y carga inicial: solo el dueño; recepción no aunque llegue directo a la base", async () => {
    const shop = await setupShop(db, "Compra banco");
    const shampoo = await product(shop, "Shampoo");
    const base = { locationId: shop.locationId, lines: [{ productId: shampoo, quantity: 10, amount: cop(80_000n) }] };
    for (const paidFrom of ["bank", "owner"] as const) {
      for (const actor of [shop.reception, { userId: "barbero", role: "barber" as const }]) {
        await expect(recordPurchase(db, { ...base, paidFrom, idempotencyKey: key("deny"), actor })).rejects.toThrow(InventoryError);
      }
    }
    // El barbero tampoco compra de la caja.
    await expect(
      recordPurchase(db, { ...base, paidFrom: "cash", idempotencyKey: key("deny"), actor: { userId: "barbero", role: "barber" } }),
    ).rejects.toThrow(InventoryError);
    expect(await db.select().from(inventoryDocuments).where(eq(inventoryDocuments.locationId, shop.locationId))).toEqual([]);

    await recordPurchase(db, { ...base, paidFrom: "bank", idempotencyKey: key("bank"), actor: shop.owner });
    await recordPurchase(db, { ...base, paidFrom: "owner", idempotencyKey: key("owner"), actor: shop.owner });
    expect(await balance(shop, ACCOUNTS.inventory.code)).toBe(cop(160_000n).minor);
    expect(await balance(shop, ACCOUNTS.bank.code)).toBe(-cop(80_000n).minor);
    expect(await balance(shop, ACCOUNTS.ownerEquity.code)).toBe(-cop(80_000n).minor);
    // Sin caja de por medio: ningún movimiento de turno.
    expect(await db.select().from(cashMovements).where(eq(cashMovements.locationId, shop.locationId))).toEqual([]);
  });

  it("de caja exige la caja abierta, el efectivo suficiente, el día abierto y productos activos de la sede", async () => {
    const shop = await setupShop(db, "Compra reglas");
    const other = await setupShop(db, "Otra sede");
    const cera = await product(shop, "Cera");
    const ajena = await product(other, "Cera ajena");
    const buy = (productId: bigint, pesos: bigint, paidFrom: "cash" | "bank" = "cash") =>
      recordPurchase(db, {
        locationId: shop.locationId,
        paidFrom,
        lines: [{ productId, quantity: 1, amount: cop(pesos) }],
        idempotencyKey: key("rule"),
        actor: paidFrom === "cash" ? shop.reception : shop.owner,
      });

    await expect(buy(cera, 10_000n)).rejects.toThrow(/Abre la caja/);
    await openDrawer(shop, 50_000n);
    await expect(buy(cera, 60_000n)).rejects.toThrow(CashError);
    await expect(buy(ajena, 10_000n)).rejects.toThrow(/no existe en esta sede/);
    await setProductActive(db, { locationId: shop.locationId, productId: cera, active: false });
    await expect(buy(cera, 10_000n)).rejects.toThrow(/desactivado/);
    await setProductActive(db, { locationId: shop.locationId, productId: cera, active: true });
    await expect(buy(cera, 10_000n)).resolves.toMatchObject({ created: true });

    // Centavos, cero o líneas repetidas: el dominio lo rechaza antes de tocar la base.
    await expect(
      recordPurchase(db, {
        locationId: shop.locationId,
        paidFrom: "cash",
        lines: [{ productId: cera, quantity: 1, amount: money(1_050n) }],
        idempotencyKey: key("cents"),
        actor: shop.reception,
      }),
    ).rejects.toThrow(InventoryError);

    // Con el día cerrado no hay compras (ni del banco).
    const shop2 = await setupShop(db, "Día cerrado");
    const p2 = await product(shop2, "Cera");
    await closeDay(db, { locationId: shop2.locationId, businessDate: today(), createdBy: shop2.owner.userId });
    await expect(
      recordPurchase(db, { locationId: shop2.locationId, paidFrom: "bank", lines: [{ productId: p2, quantity: 1, amount: cop(5_000n) }], idempotencyKey: key("closed"), actor: shop2.owner }),
    ).rejects.toThrow(/cerrado/);
  });
});

describe("conteo de inventario", () => {
  it("deja 1435 en lo contado y lleva la diferencia a 6135; repetir no ajusta dos veces", async () => {
    const shop = await setupShop(db, "Conteo");
    const cera = await product(shop, "Cera");
    const aceite = await product(shop, "Aceite");
    const owner = shop.owner;
    await recordPurchase(db, { locationId: shop.locationId, paidFrom: "owner", lines: [{ productId: cera, quantity: 10, amount: cop(100_000n) }], idempotencyKey: key("i"), actor: owner });
    await recordPurchase(db, { locationId: shop.locationId, paidFrom: "bank", lines: [{ productId: aceite, quantity: 3, amount: cop(10_000n) }], idempotencyKey: key("i"), actor: owner });

    // Falta un producto activo: el conteo es completo.
    await expect(recordCount(db, { locationId: shop.locationId, lines: [{ productId: cera, quantity: 4 }], idempotencyKey: key("c"), actor: owner })).rejects.toThrow(/Falta contar/);
    // Recepción no cuenta.
    await expect(
      recordCount(db, { locationId: shop.locationId, lines: [{ productId: cera, quantity: 4 }, { productId: aceite, quantity: 1 }], idempotencyKey: key("c"), actor: shop.reception }),
    ).rejects.toThrow(InventoryError);

    const countKey = key("count");
    const counted = await recordCount(db, {
      locationId: shop.locationId,
      lines: [
        { productId: cera, quantity: 4 },
        { productId: aceite, quantity: 1 },
      ],
      idempotencyKey: countKey,
      actor: owner,
    });
    // 4 × 10.000 + 1 × (10.000 / 3 = 3.333,33) = 43.333,33
    expect(counted.total).toEqual(money(4_333_333n));
    expect(counted.adjustment).toEqual(money(11_000_000n - 4_333_333n));
    expect(await inventoryBalance(db, shop.locationId)).toBe(4_333_333n);
    expect(await balance(shop, ACCOUNTS.costOfGoodsSold.code)).toBe(11_000_000n - 4_333_333n);

    const again = await recordCount(db, {
      locationId: shop.locationId,
      lines: [
        { productId: aceite, quantity: 1 },
        { productId: cera, quantity: 4 },
      ],
      idempotencyKey: countKey,
      actor: owner,
    });
    expect(again).toMatchObject({ documentId: counted.documentId, created: false });
    expect(await inventoryBalance(db, shop.locationId)).toBe(4_333_333n);

    // Contar más de lo que dice el libro también cuadra (Dr 1435 / Cr 6135).
    await recordCount(db, {
      locationId: shop.locationId,
      lines: [
        { productId: cera, quantity: 9 },
        { productId: aceite, quantity: 1 },
      ],
      idempotencyKey: key("count"),
      actor: owner,
    });
    expect(await inventoryBalance(db, shop.locationId)).toBe(9_000_000n + 333_333n);
    const tb = await trialBalance(db, { locationId: shop.locationId });
    expect(tb.reduce((s, r) => s + r.debits - r.credits, 0n)).toBe(0n);
  });

  it("propiedad: tras cada conteo, 1435 en el libro (SQL) es exactamente lo contado", { timeout: 120_000 }, async () => {
    const shop = await setupShop(db, "Conteo propiedad");
    const ids = [await product(shop, "P1"), await product(shop, "P2"), await product(shop, "P3")];
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant("buy" as const), i: fc.integer({ min: 0, max: 2 }), qty: fc.integer({ min: 1, max: 50 }), pesos: fc.bigInt({ min: 1n, max: 500_000n }) }),
            fc.record({ op: fc.constant("count" as const), qty: fc.array(fc.integer({ min: 0, max: 80 }), { minLength: 3, maxLength: 3 }) }),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        async (ops) => {
          for (const op of ops) {
            if (op.op === "buy") {
              await recordPurchase(db, {
                locationId: shop.locationId,
                paidFrom: "owner",
                lines: [{ productId: ids[op.i]!, quantity: op.qty, amount: cop(op.pesos) }],
                idempotencyKey: key("pb"),
                actor: shop.owner,
              });
            } else {
              const r = await recordCount(db, {
                locationId: shop.locationId,
                lines: ids.map((productId, i) => ({ productId, quantity: op.qty[i]! })),
                idempotencyKey: key("pc"),
                actor: shop.owner,
              });
              expect(await inventoryBalance(db, shop.locationId)).toBe(r.total.minor);
              expect(r.lines.reduce((s, l) => s + l.value.minor, 0n)).toBe(r.total.minor);
            }
          }
          const tb = await trialBalance(db, { locationId: shop.locationId });
          expect(tb.reduce((s, r) => s + r.debits - r.credits, 0n)).toBe(0n);
        },
      ),
      { numRuns: 15 },
    );
  });
});

describe("lo que la base garantiza (ataques por SQL)", () => {
  async function accountId(locationId: bigint, code: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(`select id::text from accounts where location_id = $1 and code = $2`, [locationId.toString(), code]);
    return rows[0]!.id;
  }

  /** Un asiento a mano (Dr debitCode / Cr creditCode) en una transacción: la base decide. */
  async function rawEntry(shop: Shop, kind: string, debitCode: string, creditCode: string): Promise<string> {
    const d = await accountId(shop.locationId, debitCode);
    const c = await accountId(shop.locationId, creditCode);
    return dbError(
      client.transaction(async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `insert into journal_entries (location_id, business_date, kind, memo, currency, created_by)
           values ($1, $2, $3, 'ataque', 'COP', 'atacante') returning id::text`,
          [shop.locationId.toString(), today(), kind],
        );
        const id = rows[0]!.id;
        await tx.query(`insert into journal_lines (location_id, entry_id, account_id, debit, credit) values ($1, $2, $3, 100000, 0), ($1, $2, $4, 0, 100000)`, [
          shop.locationId.toString(),
          id,
          d,
          c,
        ]);
      }),
    );
  }

  it("un gasto, una venta o un ajuste de caja no pueden tocar 1435 ni 6135", async () => {
    const shop = await setupShop(db, "Ataque 1435");
    for (const kind of ["expense", "sale", "cash_adjustment", "owner_contribution"]) {
      expect(await rawEntry(shop, kind, "1435", "1105")).toMatch(/inventario: la cuenta 1435/);
      expect(await rawEntry(shop, kind, "6135", "1105")).toMatch(/inventario: la cuenta 6135/);
    }
    expect(await inventoryBalance(db, shop.locationId)).toBe(0n);
  });

  it("un asiento de inventario sin documento no se confirma, ni toca otras cuentas", async () => {
    const shop = await setupShop(db, "Ataque sin documento");
    expect(await rawEntry(shop, "inventory_purchase", "1435", "1105")).toMatch(/no tiene su documento/);
    expect(await rawEntry(shop, "inventory_count", "6135", "1435")).toMatch(/no tiene su documento/);
    expect(await rawEntry(shop, "inventory_purchase", "1435", "4135")).toMatch(/no puede tocar la cuenta 4135/);
    expect(await rawEntry(shop, "inventory_count", "6135", "1105")).toMatch(/no puede tocar la cuenta 1105/);
    // Tampoco por la capa de TypeScript: el asiento solo, sin documento, se cae al COMMIT.
    expect(
      await dbError(
        postEntry(db, {
          locationId: shop.locationId,
          createdBy: shop.owner.userId,
          entry: {
            kind: "inventory_purchase",
            businessDate: today(),
            memo: "sin documento",
            lines: [
              { account: ACCOUNTS.inventory.code, side: "debit", amount: cop(1_000n) },
              { account: ACCOUNTS.bank.code, side: "credit", amount: cop(1_000n) },
            ],
          },
        }),
      ),
    ).toMatch(/no tiene su documento/);
  });

  it("documentos y líneas son solo-inserción; los productos no se borran ni cambian de sede", async () => {
    const shop = await setupShop(db, "Ataque documentos");
    const cera = await product(shop, "Cera");
    const { documentId } = await recordPurchase(db, {
      locationId: shop.locationId,
      paidFrom: "bank",
      lines: [{ productId: cera, quantity: 2, amount: cop(10_000n) }],
      idempotencyKey: key("doc"),
      actor: shop.owner,
    });
    const id = documentId.toString();
    expect(await dbError(client.query(`update inventory_documents set total = 0 where id = $1`, [id]))).toMatch(/reserva|solo|no se/i);
    expect(await dbError(client.query(`delete from inventory_documents where id = $1`, [id]))).toMatch(/reserva|solo|no se/i);
    expect(await dbError(client.query(`update inventory_document_lines set amount = 0 where document_id = $1`, [id]))).toMatch(/reserva|solo|no se/i);
    expect(await dbError(client.query(`delete from inventory_document_lines where document_id = $1`, [id]))).toMatch(/reserva|solo|no se/i);
    // Una línea más a un documento ya confirmado.
    expect(
      await dbError(
        client.query(`insert into inventory_document_lines (location_id, document_id, product_id, quantity, amount) values ($1, $2, $3, 1, 100000)`, [
          shop.locationId.toString(),
          id,
          cera.toString(),
        ]),
      ),
    ).toMatch(/ya está confirmado/);
    expect(await dbError(client.query(`delete from products where id = $1`, [cera.toString()]))).toMatch(/reserva|producto|no se/i);
    expect(await dbError(client.query(`update products set location_id = location_id + 1 where id = $1`, [cera.toString()]))).toMatch(/solo cambia/);
    // Editar lo editable sí.
    await updateProduct(db, { locationId: shop.locationId, productId: cera, draft: { name: "Cera mate", sku: "CM-1", price: cop(32_000n), commissionBps: 500 }, active: true });
    expect((await listProducts(db, { locationId: shop.locationId }))[0]).toMatchObject({ name: "Cera mate", sku: "CM-1" });
  });

  it("la reversa de una compra devuelve 1435 y la caja; el documento queda", async () => {
    const shop = await setupShop(db, "Reversa compra");
    const cera = await product(shop, "Cera");
    const { documentId } = await recordPurchase(db, {
      locationId: shop.locationId,
      paidFrom: "bank",
      lines: [{ productId: cera, quantity: 2, amount: cop(10_000n) }],
      idempotencyKey: key("rev"),
      actor: shop.owner,
    });
    const [doc] = await db.select().from(inventoryDocuments).where(eq(inventoryDocuments.id, documentId));
    await reverseEntry(db, { locationId: shop.locationId, entryId: doc!.journalEntryId!, businessDate: today(), reason: "Compra registrada por error", createdBy: shop.owner.userId });
    expect(await inventoryBalance(db, shop.locationId)).toBe(0n);
    expect(await balance(shop, ACCOUNTS.bank.code)).toBe(0n);
  });
});

describe("como villa_app", () => {
  it("crea y edita productos, compra y cuenta; no puede editar documentos ni borrar productos", { timeout: 120_000 }, async () => {
    const app = await createTestDb({ role: "app" });
    try {
      const shop = await setupShop(app.db, "App");
      const cera = (await createProduct(app.db, { locationId: shop.locationId, draft: { name: "Cera", sku: null, price: cop(30_000n), commissionBps: 0 } })).id;
      await updateProduct(app.db, { locationId: shop.locationId, productId: cera, draft: { name: "Cera", sku: "X", price: cop(31_000n), commissionBps: 0 }, active: true });
      await recordPurchase(app.db, { locationId: shop.locationId, paidFrom: "bank", lines: [{ productId: cera, quantity: 2, amount: cop(10_000n) }], idempotencyKey: key("app"), actor: shop.owner });
      await recordCount(app.db, { locationId: shop.locationId, lines: [{ productId: cera, quantity: 1 }], idempotencyKey: key("appc"), actor: shop.owner });
      expect(await inventoryBalance(app.db, shop.locationId)).toBe(cop(5_000n).minor);
      expect(await dbError(app.client.query(`delete from products`))).toMatch(/permission denied|permiso/i);
      expect(await dbError(app.client.query(`update inventory_documents set note = 'x'`))).toMatch(/permission denied|permiso/i);
      expect(await dbError(app.client.query(`update products set location_id = 1`))).toMatch(/permission denied|permiso/i);
    } finally {
      await app.client.close();
    }
  });
});
