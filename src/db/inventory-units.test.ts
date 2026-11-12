import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { fromUnits, type Money } from "@/domain/money";
import { openCashSession } from "./cash";
import { countDueToday, countReport, countSheet, recentCounts, recordCount, recordPurchase, reversePurchase } from "./inventory";
import { accountBalance } from "./ledger";
import { createProduct } from "./products";
import { checkout } from "./sales";
import { key, type Shop, setupShop } from "./sales-testing";
import { createTestDb } from "./testing";
import type { Db } from "./types";
import { decideVoid, requestVoid } from "./voids";

// Sprint 6, fase D (docs/sprint-6-productos-inventario.md): unidades esperadas contra contadas. Entre
// dos conteos: conteo anterior + compras vigentes − ventas (las anuladas en el periodo devuelven sus
// unidades). Es informativo: el dinero lo fija el conteo (1435 contra 6135).

let db: Db;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await client?.close();
});

const cop = (pesos: bigint): Money => fromUnits(pesos);
const PRICE = 30_000n;

async function product(shop: Shop, name: string): Promise<bigint> {
  return (await createProduct(db, { locationId: shop.locationId, draft: { name, sku: null, price: cop(PRICE), commissionBps: 0 } })).id;
}

const buy = (shop: Shop, productId: bigint, quantity: number, pesos = 10_000n) =>
  recordPurchase(db, { locationId: shop.locationId, paidFrom: "bank", lines: [{ productId, quantity, amount: cop(pesos) }], idempotencyKey: key("u-buy"), actor: shop.owner });

/** Venta de mostrador en efectivo de `quantity` unidades. */
async function sell(shop: Shop, productId: bigint, quantity: number): Promise<bigint> {
  const { saleId } = await checkout(db, {
    locationId: shop.locationId,
    appointmentId: null,
    clientId: null,
    extras: [],
    products: [{ productId, quantity, staffId: shop.reception.staffId }],
    discounts: [],
    tips: [],
    payments: [{ methodId: shop.methods.cash, amount: cop(PRICE * BigInt(quantity)) }],
    idempotencyKey: key("u-sell"),
    actor: shop.reception,
  });
  return saleId;
}

async function voidSale(shop: Shop, saleId: bigint) {
  const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Error", idempotencyKey: key("u-v"), actor: shop.reception });
  await decideVoid(db, { locationId: shop.locationId, requestId, approve: true, note: "", idempotencyKey: key("u-d"), approver: shop.owner });
}

const count = (shop: Shop, lines: { productId: bigint; quantity: number }[]) =>
  recordCount(db, { locationId: shop.locationId, lines, idempotencyKey: key("u-count"), actor: shop.owner });

const units = (rows: { productId: bigint; base: number; purchased: number; sold: number; expected: number }[], id: bigint) => {
  const r = rows.find((x) => x.productId === id)!;
  return { base: r.base, purchased: r.purchased, sold: r.sold, expected: r.expected };
};

describe("unidades esperadas contra contadas", () => {
  it("compras vigentes, ventas y anulaciones entre conteos; el informe de un conteo no cambia después", { timeout: 60_000 }, async () => {
    const shop = await setupShop(db, "Unidades");
    await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key("open"), actor: shop.owner });
    const cera = await product(shop, "Cera");
    const aceite = await product(shop, "Aceite");

    // Sin conteos: todo desde el principio.
    await buy(shop, cera, 10, 100_000n);
    let sheet = await countSheet(db, shop.locationId);
    expect(sheet.lastCount).toBeNull();
    expect(units(sheet.rows, cera)).toEqual({ base: 0, purchased: 10, sold: 0, expected: 10 });
    expect(units(sheet.rows, aceite)).toEqual({ base: 0, purchased: 0, sold: 0, expected: 0 });

    const first = await count(shop, [
      { productId: cera, quantity: 10 },
      { productId: aceite, quantity: 0 },
    ]);

    // Después del conteo: una compra vigente, una anulada, dos ventas y una de ellas anulada.
    await buy(shop, cera, 5);
    const wrong = await buy(shop, aceite, 3);
    await reversePurchase(db, { locationId: shop.locationId, documentId: wrong.documentId, actor: shop.owner });
    const kept = await sell(shop, cera, 2);
    const voided = await sell(shop, cera, 1);
    await voidSale(shop, voided);

    sheet = await countSheet(db, shop.locationId);
    expect(sheet.lastCount).toMatchObject({ id: first.documentId, total: first.total });
    expect(units(sheet.rows, cera)).toEqual({ base: 10, purchased: 5, sold: 2, expected: 13 });
    expect(units(sheet.rows, aceite)).toEqual({ base: 0, purchased: 0, sold: 0, expected: 0 });

    // Se cuentan 12: falta una cera.
    const second = await count(shop, [
      { productId: cera, quantity: 12 },
      { productId: aceite, quantity: 0 },
    ]);
    const report = await countReport(db, shop.locationId, second.documentId);
    expect(report?.previous?.id).toBe(first.documentId);
    expect(report?.count).toMatchObject({ id: second.documentId, total: second.total, adjustment: second.adjustment });
    const ceraRow = report!.rows.find((r) => r.productId === cera)!;
    expect(ceraRow).toMatchObject({ base: 10, purchased: 5, sold: 2, expected: 13, counted: 12, difference: -1 });
    expect(ceraRow.value.minor).toBe(second.lines.find((l) => l.productId === cera)!.value.minor);

    // Anular después del conteo una venta de antes: el informe guardado no cambia; la unidad vuelve
    // al periodo nuevo (vendidas −2).
    await voidSale(shop, kept);
    expect((await countReport(db, shop.locationId, second.documentId))!.rows.find((r) => r.productId === cera)).toMatchObject({ sold: 2, difference: -1 });
    sheet = await countSheet(db, shop.locationId);
    expect(units(sheet.rows, cera)).toEqual({ base: 12, purchased: 0, sold: -2, expected: 14 });

    // El primer conteo, contra nada.
    const firstReport = await countReport(db, shop.locationId, first.documentId);
    expect(firstReport?.previous).toBeNull();
    expect(firstReport!.rows.find((r) => r.productId === cera)).toMatchObject({ base: 0, purchased: 10, sold: 0, expected: 10, counted: 10, difference: 0 });

    // Los ajustes de los conteos son exactamente 6135.
    const counts = await recentCounts(db, shop.locationId);
    expect(counts.map((c) => c.id)).toEqual([second.documentId, first.documentId]);
    expect(counts.reduce((s, c) => s + c.adjustment.minor, 0n)).toBe(await accountBalance(db, shop.locationId, ACCOUNTS.costOfGoodsSold.code));

    // Un conteo de otra sede, una compra o un id inexistente: null.
    const other = await setupShop(db, "Unidades otra");
    expect(await countReport(db, other.locationId, second.documentId)).toBeNull();
    expect(await countReport(db, shop.locationId, wrong.documentId)).toBeNull();
    expect(await countReport(db, shop.locationId, 999_999_999n)).toBeNull();
    expect((await countSheet(db, other.locationId)).rows).toEqual([]);
  });

  it("propiedad: diferencia = contado − (conteo anterior + compras vigentes − ventas netas de anulaciones)", { timeout: 180_000 }, async () => {
    const shop = await setupShop(db, "Unidades propiedad");
    await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key("open"), actor: shop.owner });
    const ids = [await product(shop, "U1"), await product(shop, "U2")];
    const op = fc.oneof(
      fc.record({ op: fc.constant("buy" as const), i: fc.integer({ min: 0, max: 1 }), qty: fc.integer({ min: 1, max: 20 }), reverse: fc.boolean() }),
      fc.record({ op: fc.constant("sell" as const), i: fc.integer({ min: 0, max: 1 }), qty: fc.integer({ min: 1, max: 5 }), voidIt: fc.boolean() }),
      fc.record({ op: fc.constant("voidOld" as const) }),
      fc.record({ op: fc.constant("count" as const), qty: fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 2, maxLength: 2 }) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 7 }), async (ops) => {
        // El modelo arranca del estado de la base (las corridas anteriores dejaron conteos y ventas).
        const sheet = await countSheet(db, shop.locationId);
        const model = new Map(sheet.rows.map((r) => [r.productId, { base: r.base, purchased: r.purchased, sold: r.sold }]));
        const open: { saleId: bigint; i: number; qty: number }[] = [];
        for (const o of ops) {
          if (o.op === "buy") {
            const p = await buy(shop, ids[o.i]!, o.qty);
            if (o.reverse) await reversePurchase(db, { locationId: shop.locationId, documentId: p.documentId, actor: shop.owner });
            else model.get(ids[o.i]!)!.purchased += o.qty;
          } else if (o.op === "sell") {
            const saleId = await sell(shop, ids[o.i]!, o.qty);
            if (o.voidIt) await voidSale(shop, saleId);
            else {
              model.get(ids[o.i]!)!.sold += o.qty;
              open.push({ saleId, i: o.i, qty: o.qty });
            }
          } else if (o.op === "voidOld") {
            // Anula una venta vigente (quizá de antes del último conteo): sus unidades vuelven.
            const s = open.shift();
            if (s) {
              await voidSale(shop, s.saleId);
              model.get(ids[s.i]!)!.sold -= s.qty;
            }
          } else {
            const r = await count(
              shop,
              ids.map((productId, i) => ({ productId, quantity: o.qty[i]! })),
            );
            const report = (await countReport(db, shop.locationId, r.documentId))!;
            ids.forEach((id, i) => {
              const m = model.get(id)!;
              const row = report.rows.find((x) => x.productId === id)!;
              expect(row).toMatchObject({ ...m, expected: m.base + m.purchased - m.sold, counted: o.qty[i]!, difference: o.qty[i]! - (m.base + m.purchased - m.sold) });
              model.set(id, { base: o.qty[i]!, purchased: 0, sold: 0 });
            });
          }
        }
        const after = await countSheet(db, shop.locationId);
        for (const id of ids) {
          const m = model.get(id)!;
          expect(units(after.rows, id)).toEqual({ ...m, expected: m.base + m.purchased - m.sold });
        }
      }),
      { numRuns: 8 },
    );
  });

  it("recordatorio: el último día del mes en Bogotá, con productos activos y mientras no haya conteo ese día", async () => {
    const shop = await setupShop(db, "Unidades recordatorio");
    // 30 de noviembre a las 10 p. m. en Bogotá (03:00 UTC del 1.º de diciembre): sigue siendo el 30.
    const monthEnd = new Date("2026-12-01T03:00:00Z");
    const midMonth = new Date("2026-11-15T15:00:00Z");
    expect(await countDueToday(db, shop.locationId, monthEnd)).toBe(false); // sin productos
    const cera = await product(shop, "Cera");
    expect(await countDueToday(db, shop.locationId, midMonth)).toBe(false);
    expect(await countDueToday(db, shop.locationId, new Date("2026-12-01T05:30:00Z"))).toBe(false); // ya es 1.º en Bogotá
    expect(await countDueToday(db, shop.locationId, monthEnd)).toBe(true);
    await recordCount(db, { locationId: shop.locationId, lines: [{ productId: cera, quantity: 0 }], idempotencyKey: key("u-due"), actor: shop.owner, now: monthEnd });
    expect(await countDueToday(db, shop.locationId, monthEnd)).toBe(false);
  });
});
