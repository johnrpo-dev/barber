import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { VoidError } from "@/domain/sales/void";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import { cashDeposit, closeBusinessDay, closeCashSession, ledgerCash, openCashSession, payTips, reopenBusinessDay, sessionSummary, tipsOwed } from "./cash";
import { postEntry, reverseEntry, trialBalance } from "./ledger";
import { chairAppointment, key, quickSale, type Shop, setupShop, simpleCheckout, TZ } from "./sales-testing";
import { checkout } from "./sales";
import { cashMovements, journalEntries, sales, voidRequests } from "./schema";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";
import { decideVoid, requestVoid, voidQueue } from "./voids";

// Anulaciones sobre PostgreSQL real (PGlite): la aprobación es la reversa exacta del asiento,
// en el día contable de la venta, y deja la cita lista para cobrarse de nuevo (§6 y §8).

let db: Db;
let client: PGlite;
const cop = (pesos: bigint) => fromUnits(pesos);
let shopSeq = 0;
const newShop = () => setupShop(db, `Anulaciones ${++shopSeq}`);

beforeAll(async () => {
  ({ db, client } = await createTestDb());
}, 120_000);

afterAll(async () => {
  await client?.close();
});

async function balances(shop: Shop) {
  const rows = await trialBalance(db, { locationId: shop.locationId });
  return Object.fromEntries(rows.map((r) => [r.code, r.debits - r.credits]).filter(([, v]) => v !== 0n));
}

const ask = (shop: Shop, saleId: bigint, reason = "Se cobró dos veces") =>
  requestVoid(db, { locationId: shop.locationId, saleId, reason, idempotencyKey: key("void"), actor: shop.reception });
const decide = (shop: Shop, requestId: bigint, approve: boolean, note = "", approver: { userId: string; role: Shop["owner"]["role"] | "reception" } = shop.owner) =>
  decideVoid(db, { locationId: shop.locationId, requestId, approve, note, idempotencyKey: key("decide"), approver });

describe("aprobar una anulación", () => {
  it("deja el libro como antes de la venta, marca la venta anulada y la cita se puede cobrar de nuevo", async () => {
    const shop = await newShop();
    const before = await balances(shop);
    const { saleId, appointmentId } = await quickSale(db, shop, { kind: "card", tip: 3_000n });
    const { requestId } = await ask(shop, saleId);
    expect(await decide(shop, requestId, true)).toMatchObject({ status: "approved", warning: null, created: true });
    expect(await balances(shop)).toEqual(before);
    const [sale] = await db.select().from(sales).where(eq(sales.id, saleId));
    expect(sale).toMatchObject({ status: "voided", businessDate: businessDate(new Date(), TZ) });
    expect(sale!.voidEntryId).not.toBeNull();
    const [req] = await db.select().from(voidRequests).where(eq(voidRequests.id, requestId));
    expect(req).toMatchObject({ status: "approved", decidedBy: shop.owner.userId });
    // La cita (ya terminada) se cobra otra vez.
    await expect(checkout(db, simpleCheckout(shop, appointmentId))).resolves.toMatchObject({ created: true });
  });

  it("en efectivo con la caja abierta: la devolución es un movimiento del turno y el esperado baja", async () => {
    const shop = await newShop();
    await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner });
    const { saleId } = await quickSale(db, shop, { kind: "cash" });
    expect(await ledgerCash(db, shop.locationId)).toBe(3_000_000n);
    const { requestId } = await ask(shop, saleId);
    await decide(shop, requestId, true);
    expect(await ledgerCash(db, shop.locationId)).toBe(0n);
    const summary = await sessionSummary(db, shop.locationId);
    expect(summary!.unexplained).toBe(0n);
    expect(summary!.byKind.get("reversal")).toBe(-3_000_000n);
    const moves = await db
      .select({ kind: cashMovements.kind })
      .from(cashMovements)
      .where(and(eq(cashMovements.locationId, shop.locationId), eq(cashMovements.kind, "reversal")));
    expect(moves).toHaveLength(1);
  });

  it("en efectivo con la caja abierta pero sin ese efectivo: no se aprueba (la caja no queda negativa)", async () => {
    const shop = await newShop();
    await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner });
    const { saleId } = await quickSale(db, shop, { kind: "cash" });
    await cashDeposit(db, { locationId: shop.locationId, amount: cop(20_000n), idempotencyKey: key(), actor: shop.owner });
    const { requestId } = await ask(shop, saleId);
    await expect(decide(shop, requestId, true)).rejects.toThrow(/^En la caja no hay \$\s?30\.000 para devolver/);
    expect(await ledgerCash(db, shop.locationId)).toBe(1_000_000n);
    // Cerrar la caja ya no sirve de atajo: con la caja cerrada no se devuelve efectivo (C1).
    await closeCashSession(db, { locationId: shop.locationId, counted: cop(10_000n), idempotencyKey: key(), actor: shop.owner });
    await expect(decide(shop, requestId, true)).rejects.toThrow(/^Abre la caja para devolver el efectivo de esta venta/);
    // Con el turno abierto y el efectivo de otra venta, sí se devuelve.
    await openCashSession(db, { locationId: shop.locationId, counted: cop(10_000n), idempotencyKey: key(), actor: shop.owner });
    await quickSale(db, shop, { kind: "cash" });
    await expect(decide(shop, requestId, true)).resolves.toMatchObject({ status: "approved", warning: null });
    expect(await ledgerCash(db, shop.locationId)).toBe(1_000_000n);
  });

  it("C1: en efectivo con la caja cerrada no se aprueba; el libro no queda negativo ni la apertura inventa un sobrante", async () => {
    const shop = await newShop();
    await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner });
    const { saleId } = await quickSale(db, shop, { kind: "cash" });
    // El dueño consigna todo el efectivo y cierra en cero (el escenario de la revisión).
    await cashDeposit(db, { locationId: shop.locationId, amount: cop(30_000n), idempotencyKey: key(), actor: shop.owner });
    await closeCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner });
    const before = await balances(shop);
    const { requestId } = await ask(shop, saleId);
    await expect(decide(shop, requestId, true)).rejects.toThrow(/^Abre la caja para devolver el efectivo de esta venta/);
    expect(await balances(shop)).toEqual(before);
    expect(await ledgerCash(db, shop.locationId)).toBe(0n);
    expect((await db.select().from(sales).where(eq(sales.id, saleId)))[0]!.status).toBe("paid");
    // La apertura siguiente no tiene diferencia: nada fantasma en 5310.
    expect(await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner })).toMatchObject({
      expected: 0n,
      difference: 0n,
    });
    expect((await balances(shop))["5310"]).toBeUndefined();
    // Abierta pero vacía: tampoco (la devolución sale de la caja).
    await expect(decide(shop, requestId, true)).rejects.toThrow(/^En la caja no hay/);
  });

  it("C1 en la base: aunque la app no lo verificara, nada que deje 1105 negativo se confirma", async () => {
    const shop = await newShop();
    await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner });
    const { saleId } = await quickSale(db, shop, { kind: "cash" });
    await cashDeposit(db, { locationId: shop.locationId, amount: cop(30_000n), idempotencyKey: key(), actor: shop.owner });
    const [sale] = await db.select().from(sales).where(eq(sales.id, saleId));
    // Una reversa suelta de la venta: la frena la base (no es la anulación de la venta y dejaría 1105 en −30.000).
    expect(
      await dbError(
        db.transaction(async (tx) => {
          await reverseEntry(tx as unknown as Db, {
            locationId: shop.locationId,
            entryId: sale!.journalEntryId,
            businessDate: sale!.businessDate,
            reason: "a mano",
            createdBy: "x",
          });
        }),
      ),
    ).toMatch(/registro operativo|quedaría negativo/);
    // Un ajuste que saca más efectivo del que hay: lo frena el constraint de 1105 al hacer COMMIT.
    const err = await dbError(
      postEntry(db, {
        locationId: shop.locationId,
        createdBy: "x",
        entry: {
          businessDate: sale!.businessDate,
          kind: "cash_adjustment",
          memo: "faltante inventado",
          lines: [
            { account: ACCOUNTS.cashDifferences.code, side: "debit", amount: cop(1_000n) },
            { account: ACCOUNTS.cash.code, side: "credit", amount: cop(1_000n) },
          ],
        },
      }),
    );
    expect(err).toMatch(/1105.*quedaría negativo/);
    expect(await ledgerCash(db, shop.locationId)).toBe(0n);
  });

  it("anula una venta de un día anterior: la reversa va en el día de la venta, con su efectivo en el turno de hoy", async () => {
    const shop = await newShop();
    const yesterday = new Date(Date.now() - 86_400_000);
    const ayer = businessDate(yesterday, TZ);
    await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key(), actor: shop.owner, now: yesterday });
    const appointmentId = await chairAppointment(db, shop);
    const { saleId } = await checkout(db, { ...simpleCheckout(shop, appointmentId, { kind: "cash" }), now: yesterday });
    expect((await db.select().from(sales).where(eq(sales.id, saleId)))[0]!.businessDate).toBe(ayer);
    const { requestId } = await ask(shop, saleId);
    await decide(shop, requestId, true);
    const [voided] = await db.select().from(sales).where(eq(sales.id, saleId));
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, voided!.voidEntryId!));
    expect(entry!.businessDate).toBe(ayer);
    expect(await ledgerCash(db, shop.locationId)).toBe(0n);
    const summary = await sessionSummary(db, shop.locationId);
    expect(summary!.byKind.get("reversal")).toBe(-3_000_000n);
    expect(summary!.unexplained).toBe(0n);
  });

  it("si las propinas ya se pagaron, lo advierte; la deuda queda negativa y 2380 sigue cuadrando", async () => {
    const shop = await newShop();
    await openCashSession(db, { locationId: shop.locationId, counted: cop(10_000n), note: "Base", idempotencyKey: key(), actor: shop.owner });
    const { saleId } = await quickSale(db, shop, { kind: "cash", tip: 5_000n });
    await payTips(db, { locationId: shop.locationId, staffId: shop.barber, amount: cop(5_000n), idempotencyKey: key(), actor: shop.owner });
    const { requestId } = await ask(shop, saleId);
    const decision = await decide(shop, requestId, true);
    expect(decision.warning).toMatch(/ya se pagaron en efectivo a Andrés/);
    // La caja devolvió los $35.000 de la venta (30.000 + 5.000 de propina) y ya había pagado 5.000.
    expect(await ledgerCash(db, shop.locationId)).toBe(cop(10_000n + 35_000n - 5_000n - 35_000n).minor);
    expect(await tipsOwed(db, shop.locationId)).toEqual([{ staffId: shop.barber, name: "Andrés", owed: -500_000n }]);
    expect((await balances(shop))["2380"]).toBe(500_000n);
  });

  it("si el día de la venta está cerrado, pide reabrirlo; reabierto, se aprueba en ese mismo día", async () => {
    const shop = await newShop();
    const { saleId } = await quickSale(db, shop, { kind: "card" });
    const day = businessDate(new Date(), TZ);
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: day, actor: shop.owner });
    const { requestId } = await ask(shop, saleId);
    await expect(decide(shop, requestId, true)).rejects.toThrow(`El día ${day} de esta venta ya está cerrado. Reábrelo primero y vuelve a aprobar la anulación.`);
    expect((await db.select().from(sales).where(eq(sales.id, saleId)))[0]!.status).toBe("paid");
    await reopenBusinessDay(db, { locationId: shop.locationId, businessDate: day, reason: "Anulación pendiente", actor: shop.owner });
    await expect(decide(shop, requestId, true)).resolves.toMatchObject({ status: "approved" });
  });

  it("quien cobró no aprueba lo suyo, salvo el dueño", async () => {
    const shop = await newShop();
    const { saleId } = await quickSale(db, shop);
    const { requestId } = await ask(shop, saleId);
    await expect(decide(shop, requestId, true, "", shop.reception)).rejects.toThrow(/^Quien cobró no puede aprobar/);
    // El dueño que cobró sí puede (con un solo dueño no hay a quién más pedírselo).
    const appointmentId = await chairAppointment(db, shop);
    const own = await checkout(db, { ...simpleCheckout(shop, appointmentId), actor: shop.owner });
    const mine = await ask(shop, own.saleId);
    await expect(decide(shop, mine.requestId, true)).resolves.toMatchObject({ status: "approved" });
  });
});

describe("solicitudes y decisiones", () => {
  it("una sola pendiente por venta; rechazar exige nota; decidida no se vuelve a decidir; la misma clave repite", async () => {
    const shop = await newShop();
    const { saleId } = await quickSale(db, shop);
    const { requestId } = await ask(shop, saleId);
    await expect(ask(shop, saleId)).rejects.toThrow(/^Ya hay una solicitud de anulación pendiente/);
    await expect(ask(shop, saleId, "  ")).rejects.toThrow(/^Escribe el motivo de la anulación/);
    await expect(decide(shop, requestId, false, " ")).rejects.toThrow(/^Escribe el motivo del rechazo/);

    const k = key("decide");
    const reject = { locationId: shop.locationId, requestId, approve: false, note: "El cobro estaba bien", idempotencyKey: k, approver: shop.owner };
    expect(await decideVoid(db, reject)).toMatchObject({ status: "rejected", created: true });
    expect(await decideVoid(db, reject)).toMatchObject({ status: "rejected", created: false });
    await expect(decideVoid(db, { ...reject, note: "Otra nota" })).rejects.toThrow(IdempotencyConflictError);
    await expect(decide(shop, requestId, true)).rejects.toThrow(/^Esta solicitud ya se decidió/);

    // Rechazada, se puede volver a pedir; aprobada, ya no.
    const second = await ask(shop, saleId, "Ahora sí: el cliente devolvió el servicio");
    await decide(shop, second.requestId, true);
    await expect(ask(shop, saleId)).rejects.toThrow(/^Esta venta ya está anulada/);
    expect(await dbError(db.update(voidRequests).set({ status: "pending" }).where(eq(voidRequests.id, requestId)))).toMatch(/.+/);
  });

  it("la cola muestra primero lo pendiente; quien no aprueba ve solo lo suyo", async () => {
    const shop = await newShop();
    const a = await quickSale(db, shop);
    const b = await quickSale(db, shop);
    const first = await ask(shop, a.saleId);
    await decide(shop, first.requestId, false, "No aplica");
    const pending = await ask(shop, b.saleId);
    const all = await voidQueue(db, { locationId: shop.locationId });
    expect(all.map((r) => [r.id, r.status])).toEqual([
      [pending.requestId, "pending"],
      [first.requestId, "rejected"],
    ]);
    expect(all[0]!.lines.length).toBeGreaterThan(0);
    expect(await voidQueue(db, { locationId: shop.locationId, requestedBy: "otra-persona" })).toEqual([]);
  });

  it("la venta de otra sede no se pide ni se decide", async () => {
    const shop = await newShop();
    const other = await newShop();
    const { saleId } = await quickSale(db, shop);
    await expect(requestVoid(db, { locationId: other.locationId, saleId, reason: "x", idempotencyKey: key(), actor: other.owner })).rejects.toThrow(
      VoidError,
    );
    const { requestId } = await ask(shop, saleId);
    await expect(decide(other, requestId, true)).rejects.toThrow(/^La solicitud no existe/);
  });
});
