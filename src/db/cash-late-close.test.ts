import type { PGlite } from "@electric-sql/pglite";
import { and, eq, like } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { sessionIsFromEarlierDay } from "@/domain/sales/cash";
import {
  cashDeposit,
  cashViewData,
  closeBusinessDay,
  closeCashSession,
  lastReopenOf,
  lastUnclosedPastDay,
  ledgerCash,
  openCashSession,
  payTips,
  REOPEN_ON_CASH_OPEN_REASON,
  sessionSummary,
} from "./cash";
import { addExpense } from "./expenses";
import { closeDay, isDayClosed, trialBalance } from "./ledger";
import { chairAppointment, key, quickSale, type Shop, setupShop, simpleCheckout, TZ } from "./sales-testing";
import { checkout } from "./sales";
import { auditEvents, journalEntries, sales } from "./schema";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

// Cierre de caja tardío: si la caja quedó abierta de un día anterior, no recibe efectivo de hoy
// (las ventas de dos días no se mezclan); se cierra contando, el ajuste va al día del turno, y
// enseguida se abre la caja de hoy sin reabrir ningún día.

let db: Db;
let client: PGlite;
const cop = (pesos: bigint) => fromUnits(pesos);
let shopSeq = 0;
const newShop = () => setupShop(db, `Tardía ${++shopSeq}`);
const today = () => businessDate(new Date(), TZ);
const yesterday = () => addDays(today(), -1);
/** Ayer a las 6 p. m. en Bogotá. */
const yesterdayEvening = () => localMinuteToInstant(yesterday(), 18 * 60, TZ);

beforeAll(async () => {
  ({ db, client } = await createTestDb());
}, 120_000);

afterAll(async () => {
  await client?.close();
});

/**
 * Abre la caja "ayer por la mañana". La hora de apertura la pone la base (now()) y un trigger la
 * protege, así que el test la mueve atrás con los triggers apagados solo para esa sentencia.
 */
async function openYesterday(shop: Shop, counted = 0n) {
  const opened = await openCashSession(db, {
    locationId: shop.locationId,
    counted: cop(counted),
    note: counted ? "base" : undefined,
    idempotencyKey: key("open"),
    actor: shop.owner,
    now: yesterdayEvening(),
  });
  const at = localMinuteToInstant(yesterday(), 9 * 60, TZ).toISOString();
  await client.exec(`
    set session_replication_role = replica;
    update cash_sessions set opened_at = '${at}' where id = ${opened.sessionId};
    set session_replication_role = origin;
  `);
  return opened.sessionId;
}

const cashSaleAt = async (shop: Shop, now?: Date, tip = 0n) =>
  checkout(db, { ...simpleCheckout(shop, await chairAppointment(db, shop), { kind: "cash", tip }), now });

async function closeEntryOf(idempotencyKey: string) {
  const [row] = await db
    .select({ day: journalEntries.businessDate, memo: journalEntries.memo })
    .from(journalEntries)
    .where(eq(journalEntries.idempotencyKey, `cash-close:${idempotencyKey}`));
  return row;
}

describe("la caja que quedó abierta de ayer", () => {
  it("no recibe efectivo de hoy (cobro, gasto, propinas, consignación); con tarjeta sí se cobra", async () => {
    const shop = await newShop();
    await openYesterday(shop);
    await cashSaleAt(shop, yesterdayEvening(), 5_000n);
    const stale = /^La caja del .+ sigue abierta/;

    await expect(cashSaleAt(shop)).rejects.toThrow(stale);
    const base = { locationId: shop.locationId, idempotencyKey: key(), actor: shop.owner };
    await expect(addExpense(db, { ...base, categoryId: shop.category, amount: cop(1_000n), paidFrom: "cash", description: "Jabón" })).rejects.toThrow(stale);
    await expect(payTips(db, { ...base, staffId: shop.barber, amount: cop(1_000n) })).rejects.toThrow(stale);
    await expect(cashDeposit(db, { ...base, amount: cop(1_000n) })).rejects.toThrow(stale);

    // Tarjeta hoy: entra, pero no se suma a los "otros medios" del turno de ayer.
    await quickSale(db, shop, { kind: "card", now: yesterdayEvening() });
    await quickSale(db, shop, { kind: "card" });
    const summary = await sessionSummary(db, shop.locationId);
    expect(summary?.businessDate).toBe(yesterday());
    expect(summary?.byMethod.map((m) => m.total)).toEqual([cop(30_000n).minor]);
    expect(summary?.unexplained).toBe(0n);

    // En Caja se ve como caja de otro día, y ayer como día pendiente.
    const view = await cashViewData(db, shop.locationId);
    expect(view.summary && sessionIsFromEarlierDay(view.summary.businessDate, view.day.businessDate)).toBe(true);
    expect(view.pendingDay).toBe(yesterday());
  });

  it("se cierra tarde contando: el ajuste va a ayer; luego se abre la de hoy sin reabrir nada, y ayer se puede cerrar", async () => {
    const shop = await newShop();
    const sessionId = await openYesterday(shop);
    await cashSaleAt(shop, yesterdayEvening());
    // El día de ayer no se cierra mientras su caja siga abierta.
    await expect(closeBusinessDay(db, { locationId: shop.locationId, businessDate: yesterday(), actor: shop.owner })).rejects.toThrow(
      /^Cierra la caja antes de cerrar el día/,
    );

    const closeKey = key("close");
    const closed = await closeCashSession(db, {
      locationId: shop.locationId,
      counted: cop(29_000n),
      note: "Faltan mil",
      idempotencyKey: closeKey,
      actor: shop.reception,
    });
    expect(closed).toMatchObject({ sessionId, expected: cop(30_000n).minor, counted: cop(29_000n).minor, difference: -cop(1_000n).minor });
    expect(await closeEntryOf(closeKey)).toEqual({ day: yesterday(), memo: `Cierre de caja del ${yesterday()} (tardío): Faltan mil` });
    expect(await ledgerCash(db, shop.locationId)).toBe(cop(29_000n).minor);

    // La de hoy se abre de una, sin diferencia, y recibe efectivo de hoy.
    const opened = await openCashSession(db, { locationId: shop.locationId, counted: cop(29_000n), idempotencyKey: key("open"), actor: shop.reception });
    expect(opened.difference).toBe(0n);
    const sale = await cashSaleAt(shop);
    const [row] = await db.select({ day: sales.businessDate }).from(sales).where(eq(sales.id, sale.saleId));
    expect(row?.day).toBe(today());
    expect((await sessionSummary(db, shop.locationId))?.businessDate).toBe(today());

    // Ayer se cierra con la caja de hoy abierta (desde la app y en la base); hoy, no.
    expect(await lastUnclosedPastDay(db, shop.locationId, today())).toBe(yesterday());
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: yesterday(), actor: shop.owner });
    expect(await lastUnclosedPastDay(db, shop.locationId, today())).toBeNull();
    await expect(closeBusinessDay(db, { locationId: shop.locationId, businessDate: today(), actor: shop.owner })).rejects.toThrow(
      /^Cierra la caja antes de cerrar el día/,
    );
    expect(await dbError(closeDay(db, { locationId: shop.locationId, businessDate: today(), createdBy: "x" }))).toMatch(/cierra la caja antes de cerrar el día/);
  });

  it("un cierre del mismo día sigue igual: ajuste en el día y sin la marca de tardío", async () => {
    const shop = await newShop();
    await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key("open"), actor: shop.owner });
    await cashSaleAt(shop);
    const closeKey = key("close");
    await closeCashSession(db, { locationId: shop.locationId, counted: cop(31_000n), note: "Sobra", idempotencyKey: closeKey, actor: shop.owner });
    expect(await closeEntryOf(closeKey)).toEqual({ day: today(), memo: "Cierre de caja: Sobra" });
  });
});

describe("propiedad: el cierre tardío no mezcla días", () => {
  it("para cualquier venta de ayer y cualquier conteo: diferencia = contado − esperado, todo lo del turno queda en ayer y hoy abre en cero", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 0n, max: 20_000n }), { minLength: 0, maxLength: 3 }),
        fc.bigInt({ min: -40_000n, max: 40_000n }),
        async (tips, delta) => {
          const shop = await newShop();
          await openYesterday(shop);
          for (const tip of tips) await cashSaleAt(shop, yesterdayEvening(), tip);
          const expected = await ledgerCash(db, shop.locationId);
          const counted = expected / 100n + delta < 0n ? 0n : expected / 100n + delta;
          const closeKey = key("close");
          const closed = await closeCashSession(db, {
            locationId: shop.locationId,
            counted: cop(counted),
            note: "conteo",
            idempotencyKey: closeKey,
            actor: shop.owner,
          });
          expect(closed.difference).toBe(cop(counted).minor - expected);
          expect(await ledgerCash(db, shop.locationId)).toBe(cop(counted).minor);
          const entry = await closeEntryOf(closeKey);
          if (closed.difference === 0n) expect(entry).toBeUndefined();
          else expect(entry?.day).toBe(yesterday());
          // Nada del turno de ayer quedó fechado hoy.
          const todays = await db
            .select({ id: journalEntries.id })
            .from(journalEntries)
            .where(and(eq(journalEntries.locationId, shop.locationId), eq(journalEntries.businessDate, today())));
          expect(todays).toEqual([]);
          // La de hoy abre sin diferencia contando lo mismo, y el libro cuadra.
          const opened = await openCashSession(db, { locationId: shop.locationId, counted: cop(counted), idempotencyKey: key("open"), actor: shop.owner });
          expect(opened.difference).toBe(0n);
          const rows = await trialBalance(db, { locationId: shop.locationId });
          expect(rows.reduce((a, r) => a + r.debits, 0n)).toBe(rows.reduce((a, r) => a + r.credits, 0n));
          // Solo el cierre con diferencia lleva la marca de tardío.
          const late = await db
            .select({ id: journalEntries.id })
            .from(journalEntries)
            .where(and(eq(journalEntries.locationId, shop.locationId), like(journalEntries.memo, "%(tardío)%")));
          expect(late.length).toBe(closed.difference === 0n ? 0 : 1);
        },
      ),
      { numRuns: 8 },
    );
  }, 120_000);
});

// Si el día de HOY se cerró antes de tiempo, recepción no se queda sin operar: abrir la caja lo
// reabre en la misma transacción, con su nombre. Un día anterior cerrado sigue cerrado.

describe("abrir la caja con el día de hoy cerrado", () => {
  const closeToday = (shop: Shop) => closeBusinessDay(db, { locationId: shop.locationId, businessDate: today(), actor: shop.owner });

  it("con permiso, abrir la caja reabre hoy y queda registrado con quien abrió; cobra normal", async () => {
    const shop = await newShop();
    await closeToday(shop);
    const opened = await openCashSession(db, {
      locationId: shop.locationId,
      counted: cop(0n),
      idempotencyKey: key("open"),
      actor: shop.reception,
      reopenClosedToday: true,
    });
    expect(opened.created).toBe(true);
    expect(await isDayClosed(db, shop.locationId, today())).toBe(false);
    expect(await lastReopenOf(db, shop.locationId, today())).toMatchObject({ reason: REOPEN_ON_CASH_OPEN_REASON });
    const audit = await db
      .select({ action: auditEvents.action, actor: auditEvents.actorUserId })
      .from(auditEvents)
      .where(and(eq(auditEvents.locationId, shop.locationId), eq(auditEvents.action, "day.reopen")));
    expect(audit).toEqual([{ action: "day.reopen", actor: shop.reception.userId }]);
    await cashSaleAt(shop);
    expect(await ledgerCash(db, shop.locationId)).toBe(cop(30_000n).minor);
  });

  it("sin el permiso sigue rechazando la apertura y no cambia nada", async () => {
    const shop = await newShop();
    await closeToday(shop);
    await expect(openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key("open"), actor: shop.owner })).rejects.toThrow(
      /^El día ya está cerrado/,
    );
    expect(await isDayClosed(db, shop.locationId, today())).toBe(true);
    expect(await lastReopenOf(db, shop.locationId, today())).toBeNull();
  });

  it("propiedad: para cualquier conjunto de días anteriores cerrados, abrir la caja solo reabre hoy", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 1, max: 6 }), { maxLength: 4 }), fc.boolean(), fc.bigInt({ min: 0n, max: 50_000n }), async (back, todayClosed, counted) => {
        const shop = await newShop();
        const past = back.map((n) => addDays(today(), -n));
        for (const d of past) await closeBusinessDay(db, { locationId: shop.locationId, businessDate: d, actor: shop.owner });
        if (todayClosed) await closeToday(shop);
        const opened = await openCashSession(db, {
          locationId: shop.locationId,
          counted: cop(counted),
          note: "base",
          idempotencyKey: key("open"),
          actor: shop.reception,
          reopenClosedToday: true,
        });
        expect(opened.difference).toBe(cop(counted).minor);
        expect(await ledgerCash(db, shop.locationId)).toBe(cop(counted).minor);
        expect(await isDayClosed(db, shop.locationId, today())).toBe(false);
        for (const d of past) expect(await isDayClosed(db, shop.locationId, d)).toBe(true);
        // Solo hubo reapertura si hoy estaba cerrado.
        expect((await lastReopenOf(db, shop.locationId, today())) !== null).toBe(todayClosed);
      }),
      { numRuns: 8 },
    );
  }, 120_000);
});
