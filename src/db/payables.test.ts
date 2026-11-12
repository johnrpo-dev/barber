import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits, type Money, money } from "@/domain/money";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import { closeCashSession, ledgerCash, openCashSession } from "./cash";
import { inventoryBalance, PURCHASE_LOCK_MESSAGES, recentPurchases, recordPurchase, reversePurchase } from "./inventory";
import { accountBalance, postEntry, trialBalance } from "./ledger";
import { PAYMENT_LOCK_MESSAGES, payables, payablesDue, paySupplier, reverseSupplierPayment } from "./payables";
import { createProduct } from "./products";
import { dashboardData } from "./reports";
import { key, type Shop, setupShop, TZ } from "./sales-testing";
import { auditEvents, cashMovements, inventoryDocuments, suppliers } from "./schema";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

// Cuentas por pagar a proveedores (sprint 8, parte A; migración 0036): compra a crédito (Dr 1435 /
// Cr 2205), pagos parciales (Dr 2205 / Cr caja, banco o dueño), anulaciones, lo que se debe y lo que la
// base garantiza aunque alguien se salte TypeScript.

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
const owed = (shop: Shop) => accountBalance(db, shop.locationId, ACCOUNTS.accountsPayable.code).then((b) => -b);

async function product(shop: Shop, name: string, price = 30_000n): Promise<bigint> {
  return (await createProduct(db, { locationId: shop.locationId, draft: { name, sku: null, price: cop(price), commissionBps: 0 } })).id;
}

async function openDrawer(shop: Shop, pesos = 500_000n) {
  await openCashSession(db, { locationId: shop.locationId, counted: cop(pesos), note: "Base de prueba", idempotencyKey: key("open"), actor: shop.owner });
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

function buyOnCredit(shop: Shop, productId: bigint, pesos: bigint, supplierName = "Distribuidora Norte", termDays = 30, actor: Shop["owner"] | Shop["reception"] = shop.owner) {
  return recordPurchase(db, {
    locationId: shop.locationId,
    paidFrom: "credit",
    credit: { supplierName, termDays },
    lines: [{ productId, quantity: 4, amount: cop(pesos) }],
    idempotencyKey: key("credito"),
    actor,
  });
}

function pay(shop: Shop, documentId: bigint, pesos: bigint, paidFrom: "cash" | "bank" | "owner" = "bank", actor: Shop["owner"] | Shop["reception"] = shop.owner, idempotencyKey = key("pago")) {
  return paySupplier(db, { locationId: shop.locationId, documentId, amount: cop(pesos), paidFrom, idempotencyKey, actor });
}

describe("compra a crédito", () => {
  it("una sede nueva tiene 2205 (pasivo)", async () => {
    const shop = await setupShop(db, "Cuenta 2205");
    const { rows } = await client.query<{ type: string }>(`select type from accounts where location_id = $1 and code = '2205'`, [shop.locationId.toString()]);
    expect(rows).toEqual([{ type: "liability" }]);
  });

  it("sube 1435 contra 2205, crea el proveedor una sola vez y fija el vencimiento; repetir devuelve la misma", async () => {
    const shop = await setupShop(db, "Crédito");
    const cera = await product(shop, "Cera");
    const input = {
      locationId: shop.locationId,
      paidFrom: "credit" as const,
      credit: { supplierName: "  Distribuidora   Norte ", termDays: 15 },
      lines: [{ productId: cera, quantity: 6, amount: cop(90_000n) }],
      idempotencyKey: key("cred"),
      actor: shop.owner,
    };
    const first = await recordPurchase(db, input);
    expect(first).toMatchObject({ created: true, total: cop(90_000n) });
    expect(await inventoryBalance(db, shop.locationId)).toBe(cop(90_000n).minor);
    expect(await owed(shop)).toBe(cop(90_000n).minor);

    const [doc] = await db.select().from(inventoryDocuments).where(eq(inventoryDocuments.id, first.documentId));
    expect(doc!.paidFrom).toBe("credit");
    expect(doc!.dueDate! > doc!.businessDate).toBe(true);
    // Repetir con la misma clave: la misma compra. Otro plazo con la misma clave: conflicto.
    expect(await recordPurchase(db, input)).toMatchObject({ documentId: first.documentId, created: false });
    await expect(recordPurchase(db, { ...input, credit: { supplierName: "Distribuidora Norte", termDays: 20 } })).rejects.toThrow(IdempotencyConflictError);

    // El mismo proveedor escrito distinto no se duplica.
    await buyOnCredit(shop, cera, 10_000n, "DISTRIBUIDORA NORTE");
    const rows = await db.select().from(suppliers).where(eq(suppliers.locationId, shop.locationId));
    expect(rows.map((r) => r.name)).toEqual(["Distribuidora Norte"]);

    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.locationId, shop.locationId), eq(auditEvents.action, "inventory.purchase")));
    expect(audit[0]!.summary).toMatch(/a crédito con Distribuidora Norte, vence el \d{4}-\d{2}-\d{2}/);
    expect((await recentPurchases(db, shop.locationId))[0]!.supplierName).toBe("Distribuidora Norte");
  });

  it("exige proveedor y plazo válidos, y solo el dueño compra a crédito", async () => {
    const shop = await setupShop(db, "Crédito reglas");
    const cera = await product(shop, "Cera");
    const base = { locationId: shop.locationId, lines: [{ productId: cera, quantity: 1, amount: cop(5_000n) }], actor: shop.owner };
    await expect(recordPurchase(db, { ...base, paidFrom: "credit", idempotencyKey: key("x") })).rejects.toThrow(/proveedor y el plazo/);
    await expect(recordPurchase(db, { ...base, paidFrom: "bank", credit: { supplierName: "X Y", termDays: 1 }, idempotencyKey: key("x") })).rejects.toThrow(
      /Solo la compra a crédito/,
    );
    await expect(buyOnCredit(shop, cera, 5_000n, "A")).rejects.toThrow(/entre 2 y 80/);
    await expect(buyOnCredit(shop, cera, 5_000n, "Proveedor", 181)).rejects.toThrow(/plazo/);
    await expect(buyOnCredit(shop, cera, 5_000n, "Proveedor", 30, shop.reception)).rejects.toThrow(/Solo el dueño/);
    expect(await owed(shop)).toBe(0n);
  });
});

describe("pago a proveedor", () => {
  it("abonos parciales del banco, de la caja y del bolsillo del dueño; nunca de más", async () => {
    const shop = await setupShop(db, "Pagos");
    const cera = await product(shop, "Cera");
    const { documentId } = await buyOnCredit(shop, cera, 300_000n);
    await openDrawer(shop);
    const cashBefore = await ledgerCash(db, shop.locationId);

    const a = await pay(shop, documentId, 100_000n, "bank");
    expect(a).toMatchObject({ created: true, remaining: cop(200_000n), supplierName: "Distribuidora Norte" });
    const b = await pay(shop, documentId, 50_000n, "cash", shop.reception);
    expect(b.remaining).toEqual(cop(150_000n));
    expect(await ledgerCash(db, shop.locationId)).toBe(cashBefore - cop(50_000n).minor);
    const moves = await db.select().from(cashMovements).where(and(eq(cashMovements.locationId, shop.locationId), eq(cashMovements.kind, "supplier_payment")));
    expect(moves).toHaveLength(1);

    await expect(pay(shop, documentId, 150_001n, "owner")).rejects.toThrow(/mayor que lo que se debe/);
    const c = await pay(shop, documentId, 150_000n, "owner");
    expect(c.remaining).toEqual(cop(0n));
    await expect(pay(shop, documentId, 1n, "bank")).rejects.toThrow(/ya está pagada/);

    expect(await owed(shop)).toBe(0n);
    expect(await inventoryBalance(db, shop.locationId)).toBe(cop(300_000n).minor);
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.locationId, shop.locationId), eq(auditEvents.action, "inventory.supplier_payment")));
    expect(audit).toHaveLength(3);
    const tb = await trialBalance(db, { locationId: shop.locationId });
    expect(tb.reduce((s, r) => s + r.debits - r.credits, 0n)).toBe(0n);
  });

  it("repetir la clave devuelve el mismo pago; con otro monto es un conflicto", async () => {
    const shop = await setupShop(db, "Pago idempotente");
    const cera = await product(shop, "Cera");
    const { documentId } = await buyOnCredit(shop, cera, 80_000n);
    const k = key("repetido");
    const first = await pay(shop, documentId, 30_000n, "bank", shop.owner, k);
    const again = await pay(shop, documentId, 30_000n, "bank", shop.owner, k);
    expect(again).toMatchObject({ paymentId: first.paymentId, created: false, remaining: cop(50_000n) });
    await expect(pay(shop, documentId, 31_000n, "bank", shop.owner, k)).rejects.toThrow(IdempotencyConflictError);
    expect(await owed(shop)).toBe(cop(50_000n).minor);
  });

  it("de la caja exige el turno abierto y el efectivo suficiente; recepción no paga del banco", async () => {
    const shop = await setupShop(db, "Pago caja reglas");
    const cera = await product(shop, "Cera");
    const { documentId } = await buyOnCredit(shop, cera, 900_000n);
    await expect(pay(shop, documentId, 10_000n, "cash", shop.reception)).rejects.toThrow(/Abre la caja/);
    await openDrawer(shop, 100_000n);
    // Recepción ve el mensaje del conteo a ciegas (no le dice cuánto hay en la caja).
    await expect(pay(shop, documentId, 100_001n, "cash", shop.reception)).rejects.toThrow(/no se puede sacar de la caja/);
    await expect(pay(shop, documentId, 100_001n, "cash", shop.owner)).rejects.toThrow(/efectivo/i);
    await expect(pay(shop, documentId, 10_000n, "bank", shop.reception)).rejects.toThrow(/Solo el dueño/);
    await expect(pay(shop, documentId, 10_000n, "owner", shop.reception)).rejects.toThrow(/Solo el dueño/);
    expect(await owed(shop)).toBe(cop(900_000n).minor);
  });

  it("solo a compras a crédito vigentes de la sede", async () => {
    const shop = await setupShop(db, "Pago a qué");
    const other = await setupShop(db, "Pago otra sede");
    const cera = await product(shop, "Cera");
    const cash = await recordPurchase(db, { locationId: shop.locationId, paidFrom: "bank", lines: [{ productId: cera, quantity: 1, amount: cop(5_000n) }], idempotencyKey: key("b"), actor: shop.owner });
    await expect(pay(shop, cash.documentId, 1_000n)).rejects.toThrow(/no existe/);
    const { documentId } = await buyOnCredit(shop, cera, 20_000n);
    await expect(paySupplier(db, { locationId: other.locationId, documentId, amount: cop(1_000n), paidFrom: "bank", idempotencyKey: key("o"), actor: other.owner })).rejects.toThrow(
      /no existe/,
    );
    await reversePurchase(db, { locationId: shop.locationId, documentId, actor: shop.owner });
    await expect(pay(shop, documentId, 1_000n)).rejects.toThrow(/anulada/);
    expect(await owed(shop)).toBe(0n);
  });
});

describe("anular", () => {
  it("una compra a crédito con pagos vigentes no se anula; sin pagos sí, y la deuda desaparece", async () => {
    const shop = await setupShop(db, "Anular crédito");
    const cera = await product(shop, "Cera");
    const { documentId } = await buyOnCredit(shop, cera, 60_000n);
    const p = await pay(shop, documentId, 20_000n, "bank");
    await expect(reversePurchase(db, { locationId: shop.locationId, documentId, actor: shop.owner })).rejects.toThrow(PURCHASE_LOCK_MESSAGES.has_payments);
    expect((await recentPurchases(db, shop.locationId))[0]!.lock).toBe("has_payments");

    await reverseSupplierPayment(db, { locationId: shop.locationId, paymentId: p.paymentId, actor: shop.owner });
    expect(await owed(shop)).toBe(cop(60_000n).minor);
    expect(await reversePurchase(db, { locationId: shop.locationId, documentId, actor: shop.owner })).toMatchObject({ created: true, paidFrom: "credit" });
    expect(await owed(shop)).toBe(0n);
    expect(await inventoryBalance(db, shop.locationId)).toBe(0n);
  });

  it("un pago: la deuda vuelve, una sola vez; el de caja vuelve a su turno y con el turno cerrado no se anula", async () => {
    const shop = await setupShop(db, "Anular pago");
    const cera = await product(shop, "Cera");
    const { documentId } = await buyOnCredit(shop, cera, 100_000n);
    await openDrawer(shop);
    const cashStart = await ledgerCash(db, shop.locationId);
    const bank = await pay(shop, documentId, 30_000n, "bank");
    const cash = await pay(shop, documentId, 20_000n, "cash", shop.reception);
    await expect(reverseSupplierPayment(db, { locationId: shop.locationId, paymentId: bank.paymentId, actor: shop.reception })).rejects.toThrow(/Solo el dueño/);

    expect(await reverseSupplierPayment(db, { locationId: shop.locationId, paymentId: bank.paymentId, actor: shop.owner })).toMatchObject({ created: true });
    expect(await reverseSupplierPayment(db, { locationId: shop.locationId, paymentId: bank.paymentId, actor: shop.owner })).toMatchObject({ created: false });
    expect(await owed(shop)).toBe(cop(80_000n).minor);

    await reverseSupplierPayment(db, { locationId: shop.locationId, paymentId: cash.paymentId, actor: shop.owner });
    expect(await ledgerCash(db, shop.locationId)).toBe(cashStart);
    expect(await owed(shop)).toBe(cop(100_000n).minor);

    const third = await pay(shop, documentId, 10_000n, "cash", shop.reception);
    await closeCashSession(db, { locationId: shop.locationId, counted: money(await ledgerCash(db, shop.locationId)), idempotencyKey: key("close"), actor: shop.owner });
    await expect(reverseSupplierPayment(db, { locationId: shop.locationId, paymentId: third.paymentId, actor: shop.owner })).rejects.toThrow(
      PAYMENT_LOCK_MESSAGES.session_closed,
    );
    const view = await payables(db, shop.locationId);
    expect(view.rows[0]!.payments.map((p) => p.lock)).toEqual(["session_closed", "reversed", "reversed"]);
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.locationId, shop.locationId), eq(auditEvents.action, "inventory.supplier_payment_reverse")));
    expect(audit).toHaveLength(2);
  });
});

describe("lo que se debe", () => {
  it("lista lo pendiente con su saldo y vencimiento; Inicio cuenta lo vencido o por vencer", async () => {
    const shop = await setupShop(db, "Vista deuda");
    const cera = await product(shop, "Cera");
    const soon = await buyOnCredit(shop, cera, 50_000n, "Proveedor Uno", 2);
    const later = await buyOnCredit(shop, cera, 70_000n, "Proveedor Dos", 40);
    const paidOff = await buyOnCredit(shop, cera, 10_000n, "Proveedor Tres", 10);
    await pay(shop, soon.documentId, 20_000n);
    await pay(shop, paidOff.documentId, 10_000n);

    const view = await payables(db, shop.locationId);
    expect(view.balance).toEqual(cop(100_000n));
    expect(view.rows.map((r) => [r.supplierName, r.outstanding.minor])).toEqual([
      ["Proveedor Uno", cop(30_000n).minor],
      ["Proveedor Dos", cop(70_000n).minor],
      // Pagada hace poco: aparece al final (para poder anular el pago), con saldo 0.
      ["Proveedor Tres", 0n],
    ]);
    expect(view.rows[0]!.due).toMatchObject({ state: "soon", days: 2, label: "Vence en 2 días" });
    expect(view.rows[0]!.summary).toBe("Cera (4 u.)");
    // La suma de los saldos de la vista es lo que dice el libro.
    expect(view.rows.reduce((s, r) => s + r.outstanding.minor, 0n)).toBe(view.balance.minor);

    expect(await payablesDue(db, shop.locationId)).toEqual({ count: 1, total: cop(30_000n), overdue: 0 });
    const in10 = new Date(Date.now() + 10 * 86_400_000);
    expect(await payablesDue(db, shop.locationId, in10)).toEqual({ count: 1, total: cop(30_000n), overdue: 1 });
    const in45 = new Date(Date.now() + 45 * 86_400_000);
    expect(await payablesDue(db, shop.locationId, in45)).toEqual({ count: 2, total: cop(100_000n), overdue: 2 });
    expect(later.created).toBe(true);
  });

  it("Inicio le muestra al dueño los pagos de caja que hizo otra persona (control M-2), no los suyos ni los anulados", async () => {
    const shop = await setupShop(db, "Pagos de caja ajenos");
    // Como en producción: el dueño es una persona con usuario (setupShop no los enlaza).
    await client.query(`insert into "user" (id, name, email) values ($1, 'Dueño', $2)`, [shop.owner.userId, `${shop.owner.userId}@prueba.test`]);
    await client.query(`update staff_members set user_id = $1 where id = $2`, [shop.owner.userId, shop.owner.staffId.toString()]);
    const cera = await product(shop, "Cera");
    const { documentId } = await buyOnCredit(shop, cera, 90_000n);
    await openDrawer(shop);
    const recent = async () => (await dashboardData(db, { locationId: shop.locationId })).recentSupplierCashPayments;
    expect(await recent()).toEqual({ count: 0, total: 0n });
    await pay(shop, documentId, 10_000n, "cash", shop.owner);
    await pay(shop, documentId, 15_000n, "bank");
    expect(await recent()).toEqual({ count: 0, total: 0n });
    await pay(shop, documentId, 20_000n, "cash", shop.reception);
    const { paymentId } = await pay(shop, documentId, 5_000n, "cash", shop.reception);
    expect(await recent()).toEqual({ count: 2, total: cop(25_000n).minor });
    await reverseSupplierPayment(db, { locationId: shop.locationId, paymentId, actor: shop.owner });
    expect(await recent()).toEqual({ count: 1, total: cop(20_000n).minor });
  });
});

describe("lo que la base garantiza (ataques por SQL)", () => {
  async function accountId(locationId: bigint, code: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(`select id::text from accounts where location_id = $1 and code = $2`, [locationId.toString(), code]);
    return rows[0]!.id;
  }

  /** Un asiento a mano (Dr debitCode / Cr creditCode) y, si se pide, su fila de pago: la base decide. */
  async function rawEntry(shop: Shop, kind: string, debitCode: string, creditCode: string, amount = 100_000n, payment?: { documentId: bigint; paidFrom: string }): Promise<string> {
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
        await tx.query(`insert into journal_lines (location_id, entry_id, account_id, debit, credit) values ($1, $2, $3, $5, 0), ($1, $2, $4, 0, $5)`, [
          shop.locationId.toString(),
          id,
          d,
          c,
          amount.toString(),
        ]);
        if (payment) {
          await tx.query(
            `insert into supplier_payments (location_id, document_id, amount, paid_from, business_date, journal_entry_id, created_by, idempotency_key, request_hash)
             values ($1, $2, $3, $4, $5, $6, 'atacante', $7, repeat('a', 64))`,
            [shop.locationId.toString(), payment.documentId.toString(), amount.toString(), payment.paidFrom, today(), id, key("raw")],
          );
        }
      }),
    );
  }

  it("ningún asiento ajeno mueve 2205; un pago solo toca 2205 contra caja, banco o capital", async () => {
    const shop = await setupShop(db, "Ataque 2205");
    for (const kind of ["expense", "sale", "cash_adjustment", "owner_contribution", "inventory_count"]) {
      expect(await rawEntry(shop, kind, "2205", "1105")).toMatch(/la cuenta 2205 solo/);
    }
    expect(await rawEntry(shop, "supplier_payment", "2205", "4135")).toMatch(/no puede tocar la cuenta 4135/);
    expect(await rawEntry(shop, "supplier_payment", "1435", "1110")).toMatch(/la cuenta 1435|no puede tocar/);
    expect(await rawEntry(shop, "supplier_payment", "2205", "1110")).toMatch(/no tiene su pago/);
    expect(await owed(shop)).toBe(0n);
  });

  it("un pago a mano no supera la deuda, no es de una compra que no sea a crédito y cuadra con su asiento", async () => {
    const shop = await setupShop(db, "Ataque pago");
    const cera = await product(shop, "Cera");
    const { documentId } = await buyOnCredit(shop, cera, 50_000n);
    await pay(shop, documentId, 40_000n);
    // Lo que falta son $10.000: un pago de $10.001 por SQL no pasa.
    expect(await rawEntry(shop, "supplier_payment", "2205", "1110", cop(10_001n).minor, { documentId, paidFrom: "bank" })).toMatch(/superan su total/);
    // Lo justo sí pasa (por la capa de TypeScript).
    expect((await pay(shop, documentId, 10_000n)).remaining).toEqual(cop(0n));
    // El asiento dice banco y la fila dice dueño: no cuadra.
    const second = await buyOnCredit(shop, cera, 50_000n);
    expect(await rawEntry(shop, "supplier_payment", "2205", "1110", cop(1_000n).minor, { documentId: second.documentId, paidFrom: "owner" })).toMatch(/no es exactamente su monto/);
    // A una compra del banco: no.
    const bank = await recordPurchase(db, { locationId: shop.locationId, paidFrom: "bank", lines: [{ productId: cera, quantity: 1, amount: cop(5_000n) }], idempotencyKey: key("b"), actor: shop.owner });
    expect(await rawEntry(shop, "supplier_payment", "2205", "1110", cop(1_000n).minor, { documentId: bank.documentId, paidFrom: "bank" })).toMatch(/no es de una compra a crédito/);
    // De caja sin turno ni movimiento: no.
    expect(await rawEntry(shop, "supplier_payment", "2205", "1105", cop(1_000n).minor, { documentId: second.documentId, paidFrom: "cash" })).toMatch(/supplier_payments_paid_from_check|turno/);
    expect(await owed(shop)).toBe(cop(50_000n).minor);
  });

  it("pagos y proveedores son solo-inserción", async () => {
    const shop = await setupShop(db, "Ataque mutación");
    const cera = await product(shop, "Cera");
    const { documentId } = await buyOnCredit(shop, cera, 50_000n);
    const p = await pay(shop, documentId, 10_000n);
    expect(await dbError(client.query(`update supplier_payments set amount = 100 where id = $1`, [p.paymentId.toString()]))).toMatch(/reserva|solo|no se/i);
    expect(await dbError(client.query(`delete from supplier_payments where id = $1`, [p.paymentId.toString()]))).toMatch(/reserva|solo|no se/i);
    expect(await dbError(client.query(`update suppliers set name = 'Otro' where location_id = $1`, [shop.locationId.toString()]))).toMatch(/reserva|solo|no se/i);
    expect(await dbError(client.query(`delete from suppliers where location_id = $1`, [shop.locationId.toString()]))).toMatch(/reserva|solo|no se/i);
  });
});

describe("propiedad", () => {
  it("con compras a crédito, abonos y anulaciones cualesquiera, 2205 es la suma de lo que se debe y nunca negativo", { timeout: 180_000 }, async () => {
    const shop = await setupShop(db, "Proveedores propiedad");
    const cera = await product(shop, "Cera");
    await openDrawer(shop, 50_000_000n);
    type Op =
      | { t: "buy"; pesos: bigint }
      | { t: "pay"; doc: number; pesos: bigint; from: "cash" | "bank" | "owner" }
      | { t: "reversePay"; pay: number }
      | { t: "reverseBuy"; doc: number };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ t: fc.constant("buy" as const), pesos: fc.bigInt({ min: 1n, max: 500_000n }) }),
      fc.record({
        t: fc.constant("pay" as const),
        doc: fc.nat(5),
        pesos: fc.bigInt({ min: 1n, max: 600_000n }),
        from: fc.constantFrom("cash" as const, "bank" as const, "owner" as const),
      }),
      fc.record({ t: fc.constant("reversePay" as const), pay: fc.nat(8) }),
      fc.record({ t: fc.constant("reverseBuy" as const), doc: fc.nat(5) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 10 }), async (ops) => {
        const docs: { id: bigint; total: bigint; paid: bigint; reversed: boolean }[] = [];
        const pays: { id: bigint; doc: number; amount: bigint; reversed: boolean }[] = [];
        const start = await owed(shop);
        for (const o of ops) {
          if (o.t === "buy") {
            const r = await buyOnCredit(shop, cera, o.pesos);
            docs.push({ id: r.documentId, total: cop(o.pesos).minor, paid: 0n, reversed: false });
          } else if (o.t === "pay" && docs.length > 0) {
            const d = docs[o.doc % docs.length]!;
            const amount = cop(o.pesos).minor;
            const ok = !d.reversed && d.paid < d.total && amount <= d.total - d.paid;
            const attempt = pay(shop, d.id, o.pesos, o.from, o.from === "cash" ? shop.reception : shop.owner);
            if (!ok) {
              await expect(attempt).rejects.toThrow();
              continue;
            }
            const r = await attempt;
            d.paid += amount;
            pays.push({ id: r.paymentId, doc: docs.indexOf(d), amount, reversed: false });
          } else if (o.t === "reversePay" && pays.length > 0) {
            const p = pays[o.pay % pays.length]!;
            const r = await reverseSupplierPayment(db, { locationId: shop.locationId, paymentId: p.id, actor: shop.owner });
            expect(r.created).toBe(!p.reversed);
            if (!p.reversed) docs[p.doc]!.paid -= p.amount;
            p.reversed = true;
          } else if (o.t === "reverseBuy" && docs.length > 0) {
            const d = docs[o.doc % docs.length]!;
            const attempt = reversePurchase(db, { locationId: shop.locationId, documentId: d.id, actor: shop.owner });
            if (d.paid > 0n) {
              await expect(attempt).rejects.toThrow(PURCHASE_LOCK_MESSAGES.has_payments);
              continue;
            }
            const r = await attempt;
            expect(r.created).toBe(!d.reversed);
            d.reversed = true;
          }
        }
        const expected = docs.filter((d) => !d.reversed).reduce((s, d) => s + d.total - d.paid, 0n);
        expect(await owed(shop)).toBe(start + expected);
        expect(await owed(shop)).toBeGreaterThanOrEqual(0n);
        // La vista suma lo mismo que el libro (lo pendiente de todas las rondas).
        const view = await payables(db, shop.locationId);
        expect(view.rows.reduce((s, r) => s + r.outstanding.minor, 0n)).toBe(view.balance.minor);
        const tb = await trialBalance(db, { locationId: shop.locationId });
        expect(tb.reduce((s, r) => s + r.debits - r.credits, 0n)).toBe(0n);
      }),
      { numRuns: 12 },
    );
  });
});

describe("como villa_app", () => {
  it("compra a crédito, paga y anula; no puede editar pagos ni proveedores", { timeout: 120_000 }, async () => {
    const app = await createTestDb({ role: "app" });
    try {
      const shop = await setupShop(app.db, "App proveedores");
      const cera = (await createProduct(app.db, { locationId: shop.locationId, draft: { name: "Cera", sku: null, price: cop(30_000n), commissionBps: 0 } })).id;
      const { documentId } = await recordPurchase(app.db, {
        locationId: shop.locationId,
        paidFrom: "credit",
        credit: { supplierName: "Proveedor App", termDays: 30 },
        lines: [{ productId: cera, quantity: 2, amount: cop(40_000n) }],
        idempotencyKey: key("app"),
        actor: shop.owner,
      });
      const p = await paySupplier(app.db, { locationId: shop.locationId, documentId, amount: cop(15_000n), paidFrom: "bank", idempotencyKey: key("appp"), actor: shop.owner });
      await reverseSupplierPayment(app.db, { locationId: shop.locationId, paymentId: p.paymentId, actor: shop.owner });
      expect((await payables(app.db, shop.locationId)).balance).toEqual(cop(40_000n));
      expect(await dbError(app.client.query(`update supplier_payments set amount = 1`))).toMatch(/permission denied|permiso/i);
      expect(await dbError(app.client.query(`update suppliers set name = 'x'`))).toMatch(/permission denied|permiso/i);
      expect(await dbError(app.client.query(`delete from suppliers`))).toMatch(/permission denied|permiso/i);
    } finally {
      await app.client.close();
    }
  });
});
