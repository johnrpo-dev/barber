import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromUnits } from "@/domain/money";
import { toCsv } from "@/domain/reports/csv";
import { closeCashSession, ledgerCash, openCashSession, today } from "./cash";
import { cashSessionsInPeriod, salesByDay, salesDetail } from "./history";
import { key, quickSale, setupShop, type Shop } from "./sales-testing";
import { createTestDb } from "./testing";
import type { Db } from "./types";
import { decideVoid, requestVoid } from "./voids";

// Historial del dueño (sprint 6): ventas por día y aperturas/cierres de caja, sumado en SQL.
// Lo que se verifica: el total del periodo es la suma de los días, efectivo + otros medios es lo
// cobrado, las anuladas se cuentan pero no suman, y nada se cruza entre sedes.

let db: Db;
let client: PGlite;
let shop: Shop;
let other: Shop;
let day: string;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  shop = await setupShop(db, "Villa");
  other = await setupShop(db, "Otra sede");
  day = (await today(db, shop.locationId)).businessDate;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

const q = (s: Shop) => ({ locationId: s.locationId, from: day, to: day });

describe("historial de ventas", () => {
  it("por día: cobrado, efectivo, otros medios y propinas; las anuladas cuentan aparte y no suman", async () => {
    await openCashSession(db, { locationId: shop.locationId, counted: fromUnits(0n), idempotencyKey: key("open"), actor: shop.owner });
    await quickSale(db, shop, { kind: "cash" });
    await quickSale(db, shop, { kind: "card", tip: 2_000n });
    const voided = await quickSale(db, shop, { kind: "transfer" });
    const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId: voided.saleId, reason: "Cobro doble", idempotencyKey: key("void"), actor: shop.reception });
    await decideVoid(db, { locationId: shop.locationId, requestId, approve: true, note: "", idempotencyKey: key("decide"), approver: shop.owner });
    await quickSale(db, other, { kind: "card" });

    const { days, total } = await salesByDay(db, q(shop));
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ businessDate: day, paid: 2, voided: 1 });
    expect(total).toMatchObject({ businessDate: null, paid: 2, voided: 1 });
    expect(total.total).toBe(fromUnits(62_000n).minor);
    expect(total.tips).toBe(fromUnits(2_000n).minor);
    expect(total.cash).toBe(fromUnits(30_000n).minor);
    expect(total.other).toBe(fromUnits(32_000n).minor);
    expect(total.cash + total.other).toBe(total.total);
  });

  it("propiedad: el total del periodo es la suma de los días, y efectivo + otros = cobrado", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ kind: fc.constantFrom("cash", "card", "transfer", "wallet"), tip: fc.constantFrom(0n, 1_000n, 5_000n) }), { maxLength: 4 }), async (batch) => {
        for (const s of batch) await quickSale(db, shop, { kind: s.kind as "cash" | "card" | "transfer" | "wallet", tip: s.tip });
        const { days, total } = await salesByDay(db, q(shop));
        const sumOf = (f: (r: (typeof days)[number]) => bigint) => days.reduce((acc, r) => acc + f(r), 0n);
        expect(sumOf((r) => r.total)).toBe(total.total);
        expect(sumOf((r) => r.cash)).toBe(total.cash);
        expect(total.cash + total.other).toBe(total.total);
        expect(days.reduce((acc, r) => acc + r.paid, 0)).toBe(total.paid);
      }),
      { numRuns: 5 },
    );
  });

  it("sin ventas: total en cero y sin días", async () => {
    const r = await salesByDay(db, { locationId: shop.locationId, from: "2020-01-01", to: "2020-01-31" });
    expect(r.days).toEqual([]);
    expect(r.total).toMatchObject({ paid: 0, voided: 0, total: 0n });
  });

  it("detalle para exportar: una fila por venta, con servicios, quién atendió y medios; sin cliente", async () => {
    const rows = await salesDetail(db, { ...q(shop), limit: 1000 });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((r) => r.status === "voided")).toBe(true);
    for (const r of rows) {
      expect(r.services).toBe("Corte");
      expect(r.staff).toBe("Andrés");
      expect(r.time).toMatch(/^\d{2}:\d{2}$/);
      expect(r.cash + r.other).toBe(r.total);
    }
    const csv = toCsv(["Servicios", "Atendió"], rows.map((r) => [{ text: r.services }, { text: r.staff }]));
    expect(csv).not.toMatch(/Juan|Pérez|\+57300/);
    expect((await salesDetail(db, { ...q(other), limit: 1000 })).every((r) => r.staff === "Andrés")).toBe(true);
  });
});

describe("historial de caja", () => {
  it("cada turno con apertura, cierre, esperado, contado y diferencia; la suma sale en SQL", async () => {
    const expected = await ledgerCash(db, shop.locationId);
    // 5.000 menos de lo esperado: faltante, con nota (la exige la base).
    await closeCashSession(db, { locationId: shop.locationId, counted: { minor: expected - 500_000n, currency: "COP" }, note: "Faltó un billete", idempotencyKey: key("close"), actor: shop.owner });
    await openCashSession(db, { locationId: shop.locationId, counted: { minor: expected - 500_000n, currency: "COP" }, idempotencyKey: key("open2"), actor: shop.owner });

    const r = await cashSessionsInPeriod(db, q(shop));
    expect(r.sessions).toHaveLength(2);
    const [open, closed] = r.sessions; // la más reciente primero
    expect(open).toMatchObject({ openedDate: day, closedDate: null, difference: null, openingDifference: 0n });
    expect(closed).toMatchObject({ openedDate: day, closedDate: day, expected, closingCounted: expected - 500_000n, difference: -500_000n, closingNote: "Faltó un billete" });
    expect(closed!.openedTime).toMatch(/^\d{2}:\d{2}$/);
    expect(r.closingDifference).toBe(-500_000n);
    expect((await cashSessionsInPeriod(db, q(other))).sessions).toEqual([]);
  });
});
