import type { PGlite } from "@electric-sql/pglite";
import { and, eq, sql } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { ENTRY_KINDS } from "@/domain/ledger/entry";
import { fromUnits, money } from "@/domain/money";
import { isExpenseCategoryAccount } from "@/domain/sales/cash";
import { CheckoutError } from "@/domain/sales/checkout";
import { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_PAYMENT_METHODS } from "@/domain/sales/defaults";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import { CHART_OF_ACCOUNTS } from "@/domain/ledger/accounts";
import { openCashSession } from "./cash";
import { addExpense } from "./expenses";
import { requestVoid } from "./voids";
import { updateCheckoutRules } from "./checkout-settings";
import { closeDay, postEntry, reopenDay, trialBalance } from "./ledger";
import { chairAppointment, key, quickSale, type Shop, setupShop, simpleCheckout, TZ } from "./sales-testing";
import { checkout, saleDetail } from "./sales";
import { appointments, cashMovements, expenseCategories, paymentMethods, saleLines, salePayments, sales, saleTips } from "./schema";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

// Cobro sobre PostgreSQL real (PGlite) con todas las migraciones: lo que el dominio calcula, la base
// lo vuelve a exigir (docs/sprint-4-cobro-caja.md §8).

let db: Db;
let client: PGlite;
let shop: Shop;
const cop = (pesos: bigint) => fromUnits(pesos);

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  shop = await setupShop(db);
  await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key("open"), actor: shop.owner });
}, 120_000);

afterAll(async () => {
  await client?.close();
});

async function balances(locationId = shop.locationId): Promise<Map<string, bigint>> {
  const rows = await trialBalance(db, { locationId });
  return new Map(rows.map((r) => [r.code, r.debits - r.credits]));
}

describe("el cobro del diseño (§3): corte con descuento, propina, efectivo y tarjeta", () => {
  it("guarda la venta, sus filas y el asiento exacto; la cita queda terminada", async () => {
    await updateCheckoutRules(db, shop.locationId, { commissionBase: "net", maxDiscountBps: 3_000n, receptionCanDiscount: true, tipsBearCardFees: false });
    await db.update(paymentMethods).set({ feeBps: 299 }).where(eq(paymentMethods.id, shop.methods.card));
    const appointmentId = await chairAppointment(db, shop);
    const before = await balances();
    const { saleId, created } = await checkout(db, {
      locationId: shop.locationId,
      appointmentId,
      extras: [],
      discounts: [{ key: "appointment", amount: cop(3_000n), reason: "Cliente frecuente" }],
      tips: [{ staffId: shop.barber, amount: cop(5_000n) }],
      payments: [
        { methodId: shop.methods.cash, amount: cop(20_000n), tendered: cop(50_000n) },
        { methodId: shop.methods.card, amount: cop(12_000n) },
      ],
      idempotencyKey: key("design"),
      actor: shop.reception,
    });
    expect(created).toBe(true);
    await db.update(paymentMethods).set({ feeBps: 0 }).where(eq(paymentMethods.id, shop.methods.card));

    const after = await balances();
    const delta = (code: string) => (after.get(code) ?? 0n) - (before.get(code) ?? 0n);
    expect(delta(ACCOUNTS.cash.code)).toBe(2_000_000n);
    expect(delta(ACCOUNTS.bank.code)).toBe(1_164_120n);
    expect(delta(ACCOUNTS.cardFees.code)).toBe(35_880n);
    expect(delta(ACCOUNTS.serviceIncome.code)).toBe(-2_700_000n);
    expect(delta(ACCOUNTS.tipsPayable.code)).toBe(-500_000n);
    expect(delta(ACCOUNTS.commissionExpense.code)).toBe(1_080_000n);
    expect(delta(ACCOUNTS.commissionsPayable.code)).toBe(-1_080_000n);

    const sale = await saleDetail(db, shop.locationId, saleId);
    expect(sale).toMatchObject({ status: "paid", totalPaid: 3_200_000n, businessDate: businessDate(new Date(), TZ) });
    expect(sale!.lines).toEqual([
      { description: "Corte", staffId: shop.barber, unitPrice: 3_000_000n, discount: 300_000n, net: 2_700_000n, commission: 1_080_000n },
    ]);
    expect(sale!.payments.map((p) => [p.kind, p.amount, p.tendered, p.change, p.fee])).toEqual([
      ["cash", 2_000_000n, 5_000_000n, 3_000_000n, 0n],
      ["card", 1_200_000n, null, null, 35_880n],
    ]);
    const [appt] = await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId));
    expect(appt?.status).toBe("completed");
    // El efectivo quedó como movimiento del turno abierto.
    const moves = await db.select().from(cashMovements).where(eq(cashMovements.kind, "sale"));
    expect(moves.length).toBeGreaterThanOrEqual(1);
  });

  it("la comisión sale del catálogo y se congela: cambiarla después no toca la venta", async () => {
    const { saleId } = await quickSale(db, shop);
    await db.execute(sql`update services set commission_bps = 5000 where id = ${shop.service}`);
    const sale = await saleDetail(db, shop.locationId, saleId);
    expect(sale!.lines[0]!.commission).toBe(1_200_000n);
    await db.execute(sql`update services set commission_bps = 4000 where id = ${shop.service}`);
  });
});

describe("idempotencia y concurrencia", () => {
  it("doble toque con la misma clave: una sola venta", async () => {
    const appointmentId = await chairAppointment(db, shop);
    const cmd = simpleCheckout(shop, appointmentId);
    const first = await checkout(db, cmd);
    const second = await checkout(db, cmd);
    expect(second).toEqual({ saleId: first.saleId, created: false });
    const rows = await db.select({ id: sales.id }).from(sales).where(eq(sales.appointmentId, appointmentId));
    expect(rows).toHaveLength(1);
  });

  it("misma clave con otro contenido: conflicto, sin registrar nada", async () => {
    const appointmentId = await chairAppointment(db, shop);
    const cmd = simpleCheckout(shop, appointmentId);
    await checkout(db, cmd);
    const count = await db.$count(sales);
    await expect(checkout(db, { ...cmd, tips: [{ staffId: shop.barber, amount: cop(1_000n) }] })).rejects.toThrow(IdempotencyConflictError);
    expect(await db.$count(sales)).toBe(count);
  });

  it("dos cobros simultáneos de la misma cita (claves distintas): una sola venta", async () => {
    const appointmentId = await chairAppointment(db, shop);
    const results = await Promise.allSettled([
      checkout(db, simpleCheckout(shop, appointmentId)),
      checkout(db, simpleCheckout(shop, appointmentId, { kind: "transfer" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(CheckoutError);
    expect((rejected.reason as Error).message).toMatch(/^Esta cita ya está cobrada/);
    const rows = await db.select({ id: sales.id }).from(sales).where(and(eq(sales.appointmentId, appointmentId), eq(sales.status, "paid")));
    expect(rows).toHaveLength(1);
  });

  it("la base impide dos ventas pagadas de la misma cita aunque la app lo intentara", async () => {
    const { appointmentId } = await quickSale(db, shop);
    const err = await dbError(
      db.transaction(async (tx) => {
        const [sale] = await tx.select().from(sales).where(eq(sales.appointmentId, appointmentId));
        const entry = await postEntry(tx as unknown as Db, {
          locationId: shop.locationId,
          createdBy: "x",
          entry: {
            businessDate: sale!.businessDate,
            kind: "sale",
            memo: "duplicada",
            lines: [
              { account: ACCOUNTS.bank.code, side: "debit", amount: cop(30_000n) },
              { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: cop(30_000n) },
            ],
          },
        });
        await tx.insert(sales).values({ ...sale!, id: undefined, publicId: `dup-${key()}`, journalEntryId: entry.entryId, idempotencyKey: key() } as never);
      }),
    );
    expect(err).toMatch(/sales_one_paid_per_appointment/);
  });
});

describe("reglas del cobro", () => {
  it("efectivo sin caja abierta: se rechaza; con tarjeta sí se cobra", async () => {
    const other = await setupShop(db, "Sin caja");
    const appointmentId = await chairAppointment(db, other);
    await expect(checkout(db, simpleCheckout(other, appointmentId, { kind: "cash" }))).rejects.toThrow(/^Abre la caja para recibir efectivo/);
    await expect(checkout(db, simpleCheckout(other, appointmentId, { kind: "card" }))).resolves.toMatchObject({ created: true });
  });

  it("en un día cerrado no se cobra", async () => {
    const other = await setupShop(db, "Día cerrado");
    const day = businessDate(new Date(), TZ);
    await closeDay(db, { locationId: other.locationId, businessDate: day, createdBy: "x" });
    const appointmentId = await chairAppointment(db, other);
    await expect(checkout(db, simpleCheckout(other, appointmentId))).rejects.toThrow(/^El día ya está cerrado/);
    await reopenDay(db, { locationId: other.locationId, businessDate: day, reason: "prueba", createdBy: "x" });
    await expect(checkout(db, simpleCheckout(other, appointmentId))).resolves.toMatchObject({ created: true });
  });

  it("solo se cobra una cita en silla o terminada (y las terminadas también)", async () => {
    const done = await chairAppointment(db, shop, { completed: true });
    await expect(checkout(db, simpleCheckout(shop, done))).resolves.toMatchObject({ created: true });
    const appointmentId = await chairAppointment(db, shop);
    await db.execute(sql`update appointments set status = 'arrived' where id = ${appointmentId}`);
    await expect(checkout(db, simpleCheckout(shop, appointmentId))).rejects.toThrow(/en silla o terminada/);
  });

  it("descuentos: recepción solo si la sede lo habilita; tope y motivo", async () => {
    const other = await setupShop(db, "Descuentos");
    const withDiscount = async (amount: bigint, reason: string, actor: Shop["owner"] | Shop["reception"] = other.reception) => {
      const appointmentId = await chairAppointment(db, other);
      return checkout(db, {
        ...simpleCheckout(other, appointmentId),
        discounts: [{ key: "appointment", amount: cop(amount), reason }],
        payments: [{ methodId: other.methods.card, amount: cop(30_000n - amount) }],
        actor,
      });
    };
    await expect(withDiscount(3_000n, "Frecuente")).rejects.toThrow(/No tienes permiso para dar descuentos/);
    await expect(withDiscount(3_000n, "Frecuente", other.owner)).resolves.toMatchObject({ created: true });
    await updateCheckoutRules(db, other.locationId, { commissionBase: "net", maxDiscountBps: 3_000n, receptionCanDiscount: true, tipsBearCardFees: false });
    await expect(withDiscount(3_000n, "Frecuente")).resolves.toMatchObject({ created: true });
    await expect(withDiscount(9_100n, "Mucho")).rejects.toThrow(/^El descuento supera el tope/);
    await expect(withDiscount(1_000n, "  ")).rejects.toThrow(/^Escribe el motivo del descuento/);
  });

  it("los mensajes del contrato: falta dinero, sobra, efectivo entregado", async () => {
    const appointmentId = await chairAppointment(db, shop);
    const base = simpleCheckout(shop, appointmentId);
    const pay = (amount: bigint, tendered?: bigint) =>
      checkout(db, { ...base, idempotencyKey: key(), payments: [{ methodId: shop.methods.cash, amount: cop(amount), tendered: tendered ? cop(tendered) : undefined }] });
    await expect(pay(20_000n)).rejects.toThrow(/^Falta dinero por cobrar/);
    await expect(pay(40_000n)).rejects.toThrow(/^Los pagos superan el total/);
    await expect(pay(30_000n, 20_000n)).rejects.toThrow(/^El efectivo entregado no alcanza/);
  });

  it("precios, comisiones, medios y personas salen de la base: lo ajeno o inactivo se rechaza", async () => {
    const other = await setupShop(db, "Ajena");
    const appointmentId = await chairAppointment(db, shop);
    const base = simpleCheckout(shop, appointmentId);
    await expect(checkout(db, { ...base, idempotencyKey: key(), payments: [{ methodId: other.methods.card, amount: cop(30_000n) }] })).rejects.toThrow(
      /medio de pago no está disponible/,
    );
    await expect(checkout(db, { ...base, idempotencyKey: key(), tips: [{ staffId: other.barber, amount: cop(1_000n) }] })).rejects.toThrow(/no está activa/);
    await expect(checkout(db, { ...base, idempotencyKey: key(), extras: [{ serviceId: other.service, staffId: shop.barber }] })).rejects.toThrow(
      /servicio/,
    );
    await expect(checkout(db, { ...simpleCheckout(other, appointmentId), idempotencyKey: key() })).rejects.toThrow(/La cita no existe/);
  });
});

describe("garantías dentro de PostgreSQL", () => {
  it("una venta pagada no se modifica ni se borra; solo pasa a anulada con la reversa de su asiento", async () => {
    const { saleId } = await quickSale(db, shop);
    expect(await dbError(db.execute(sql`update sales set total_paid = total_paid + 100, subtotal = subtotal + 100 where id = ${saleId}`))).toMatch(
      /inmutable/,
    );
    expect(await dbError(db.execute(sql`update sales set status = 'voided' where id = ${saleId}`))).toMatch(/inmutable|voided_check/);
    const [sale] = await db.select().from(sales).where(eq(sales.id, saleId));
    // Anular apuntando a un asiento que no es su reversa: no.
    expect(
      await dbError(db.execute(sql`update sales set status = 'voided', void_entry_id = ${sale!.journalEntryId}, voided_at = now() where id = ${saleId}`)),
    ).toMatch(/reversa de su asiento/);
    expect(await dbError(db.execute(sql`delete from sales where id = ${saleId}`))).toMatch(/no admite DELETE/);
  });

  it.each(["sale_lines", "sale_payments", "sale_tips", "cash_movements", "expenses"])("%s es solo-inserción", async (table) => {
    // Los triggers de fila solo se disparan si hay filas: deja al menos una en cada tabla.
    const { saleId } = await quickSale(db, shop, { kind: "cash", tip: 2_000n });
    await addExpense(db, { locationId: shop.locationId, categoryId: shop.category, amount: cop(1_000n), paidFrom: "cash", description: "Jabón", idempotencyKey: key("exp"), actor: shop.owner });
    await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Prueba", idempotencyKey: key("void"), actor: shop.reception });
    expect(await dbError(client.query(`update ${table} set location_id = location_id`))).toMatch(/no admite UPDATE/);
    expect(await dbError(client.query(`delete from ${table}`))).toMatch(/no admite DELETE/);
    expect(await dbError(client.query(`truncate ${table} cascade`))).toMatch(/no admite TRUNCATE/);
  });

  it.each(["sales", "cash_sessions", "void_requests", "payment_methods", "expense_categories"])("%s no se borra ni se vacía", async (table) => {
    const { saleId } = await quickSale(db, shop);
    await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Prueba", idempotencyKey: key("void"), actor: shop.reception });
    expect(await dbError(client.query(`delete from ${table}`))).toMatch(/no admite DELETE/);
    expect(await dbError(client.query(`truncate ${table} cascade`))).toMatch(/no admite TRUNCATE/);
  });

  it("una venta registrada no admite líneas, pagos ni propinas nuevas", async () => {
    const { saleId } = await quickSale(db, shop);
    const [line] = await db.select().from(saleLines).where(eq(saleLines.saleId, saleId));
    expect(await dbError(db.insert(saleLines).values({ ...line!, id: undefined, position: 9 } as never))).toMatch(/no admite filas nuevas/);
    const [pay] = await db.select().from(salePayments).where(eq(salePayments.saleId, saleId));
    expect(await dbError(db.insert(salePayments).values({ ...pay!, id: undefined, methodId: shop.methods.transfer } as never))).toMatch(
      /no admite filas nuevas/,
    );
    expect(await dbError(db.insert(saleTips).values({ locationId: shop.locationId, saleId, staffId: shop.barber, amount: 100n, feeShare: 0n, payable: 100n }))).toMatch(
      /no admite filas nuevas/,
    );
  });

  it("al hacer COMMIT, los totales de la venta deben ser la suma de sus filas y coincidir con el asiento", async () => {
    const appointmentId = await chairAppointment(db, shop, { completed: true });
    const day = businessDate(new Date(), TZ);
    const insertSale = (lines: boolean, linePrice: bigint) =>
      db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const entry = await postEntry(tx, {
          locationId: shop.locationId,
          createdBy: "x",
          entry: {
            businessDate: day,
            kind: "sale",
            memo: "a mano",
            lines: [
              { account: ACCOUNTS.bank.code, side: "debit", amount: cop(30_000n) },
              { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: cop(30_000n) },
            ],
          },
        });
        const [sale] = await tx
          .insert(sales)
          .values({
            locationId: shop.locationId,
            publicId: key("p"),
            appointmentId,
            businessDate: day,
            journalEntryId: entry.entryId,
            subtotal: 3_000_000n,
            discount: 0n,
            tips: 0n,
            totalPaid: 3_000_000n,
            createdBy: "x",
            idempotencyKey: key(),
            requestHash: "0".repeat(64),
          })
          .returning({ id: sales.id });
        if (!lines) return;
        await tx.insert(saleLines).values({
          locationId: shop.locationId,
          saleId: sale!.id,
          position: 0,
          serviceId: shop.service,
          staffId: shop.barber,
          description: "Corte",
          unitPrice: linePrice,
          discount: 0n,
          net: linePrice,
          commissionBps: 0,
          commission: 0n,
        });
        await tx.insert(salePayments).values({
          locationId: shop.locationId,
          saleId: sale!.id,
          methodId: shop.methods.card,
          kind: "card",
          label: "Tarjeta",
          feeBps: 0,
          amount: 3_000_000n,
          fee: 0n,
        });
      });
    expect(await dbError(insertSale(false, 0n))).toMatch(/no tiene líneas/);
    expect(await dbError(insertSale(true, 2_900_000n))).toMatch(/no son la suma/);
    // Con todo consistente, la base la acepta (el asiento coincide: 1110 y 4170 por $30.000).
    await expect(insertSale(true, 3_000_000n)).resolves.toBeUndefined();
  });

  it("efectivo sin caja: la base lo rechaza aunque la app no lo verificara", async () => {
    const other = await setupShop(db, "Caja cerrada en la base");
    const appointmentId = await chairAppointment(db, other, { completed: true });
    const day = businessDate(new Date(), TZ);
    const err = await dbError(
      db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const entry = await postEntry(tx, {
          locationId: other.locationId,
          createdBy: "x",
          entry: {
            businessDate: day,
            kind: "sale",
            memo: "efectivo sin caja",
            lines: [
              { account: ACCOUNTS.cash.code, side: "debit", amount: cop(30_000n) },
              { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: cop(30_000n) },
            ],
          },
        });
        const [sale] = await tx
          .insert(sales)
          .values({
            locationId: other.locationId,
            publicId: key("p"),
            appointmentId,
            businessDate: day,
            journalEntryId: entry.entryId,
            subtotal: 3_000_000n,
            discount: 0n,
            tips: 0n,
            totalPaid: 3_000_000n,
            createdBy: "x",
            idempotencyKey: key(),
            requestHash: "0".repeat(64),
          })
          .returning({ id: sales.id });
        await tx.insert(saleLines).values({
          locationId: other.locationId,
          saleId: sale!.id,
          position: 0,
          serviceId: other.service,
          staffId: other.barber,
          description: "Corte",
          unitPrice: 3_000_000n,
          discount: 0n,
          net: 3_000_000n,
          commissionBps: 0,
          commission: 0n,
        });
        await tx.insert(salePayments).values({
          locationId: other.locationId,
          saleId: sale!.id,
          methodId: other.methods.cash,
          kind: "cash",
          label: "Efectivo",
          feeBps: 0,
          amount: 3_000_000n,
          tendered: 3_000_000n,
          change: 0n,
          fee: 0n,
        });
      }),
    );
    expect(err).toMatch(/efectivo sin caja abierta/);
  });

  it("el efectivo siempre existe: no se desactiva, no cobra datáfono y no hay dos", async () => {
    expect(await dbError(db.update(paymentMethods).set({ active: false }).where(eq(paymentMethods.id, shop.methods.cash)))).toMatch(/cash_check/);
    expect(await dbError(db.update(paymentMethods).set({ feeBps: 100 }).where(eq(paymentMethods.id, shop.methods.cash)))).toMatch(/cash_check/);
    expect(await dbError(db.update(paymentMethods).set({ kind: "card" }).where(eq(paymentMethods.id, shop.methods.cash)))).toMatch(/tipo/);
    expect(await dbError(db.insert(paymentMethods).values({ locationId: shop.locationId, kind: "cash", label: "Otra caja" }))).toMatch(/one_cash/);
  });

  it("una categoría de gasto solo apunta a cuentas de gasto sin flujo propio", async () => {
    for (const code of ["1105", "2380", "4170", "5105", "5305", "5310"]) {
      expect(await dbError(db.update(expenseCategories).set({ accountCode: code }).where(eq(expenseCategories.id, shop.category)))).toMatch(
        /account_check/,
      );
    }
  });
});

describe("las listas del código y los CHECK de la base no se separan", () => {
  async function checkValues(constraint: string): Promise<string[]> {
    const { rows } = await client.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [constraint]);
    expect(rows[0], constraint).toBeDefined();
    return [...rows[0]!.def.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
  }

  it("ENTRY_KINDS = journal_entries_kind_check", async () => {
    expect(await checkValues("journal_entries_kind_check")).toEqual([...ENTRY_KINDS].sort());
  });

  it("isExpenseCategoryAccount = expense_categories_account_check", async () => {
    const allowed = CHART_OF_ACCOUNTS.filter((a) => isExpenseCategoryAccount(a.code)).map((a) => a.code).sort();
    expect(await checkValues("expense_categories_account_check")).toEqual(allowed);
  });

  it("una sede nueva trae los medios de pago y las categorías por defecto", async () => {
    const other = await setupShop(db, "Nueva");
    const methods = await db.select({ kind: paymentMethods.kind, label: paymentMethods.label }).from(paymentMethods).where(eq(paymentMethods.locationId, other.locationId));
    expect(methods).toEqual(DEFAULT_PAYMENT_METHODS.map((m) => ({ kind: m.kind, label: m.label })));
    const cats = await db.select({ name: expenseCategories.name }).from(expenseCategories).where(eq(expenseCategories.locationId, other.locationId));
    expect(cats.map((c) => c.name).sort()).toEqual(DEFAULT_EXPENSE_CATEGORIES.map((c) => c.name).sort());
  });
});

describe("propiedades del cobro contra la base", () => {
  it("cualquier venta válida queda cuadrada: pagado = neto + propinas; 2380 = suma de payable; comisión congelada por línea", async () => {
    const other = await setupShop(db, "Propiedades");
    await openCashSession(db, { locationId: other.locationId, counted: cop(0n), idempotencyKey: key("open"), actor: other.owner });
    await updateCheckoutRules(db, other.locationId, { commissionBase: "net", maxDiscountBps: 5_000n, receptionCanDiscount: false, tipsBearCardFees: true });
    await db.update(paymentMethods).set({ feeBps: 299 }).where(eq(paymentMethods.id, other.methods.card));
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          discount: fc.bigInt({ min: 0n, max: 15_000n }),
          extra: fc.boolean(),
          tip: fc.bigInt({ min: 0n, max: 20_000n }),
          cashShare: fc.bigInt({ min: 0n, max: 100n }),
          useWallet: fc.boolean(),
        }),
        async ({ discount, extra, tip, cashShare, useWallet }) => {
          const appointmentId = await chairAppointment(db, other);
          const net = 30_000n - discount + (extra ? 30_000n : 0n);
          const total = net + tip;
          const cash = (total * cashShare) / 100n;
          const electronic = total - cash;
          const payments = [
            ...(cash > 0n ? [{ methodId: other.methods.cash, amount: cop(cash), tendered: cop(cash + 7_000n) }] : []),
            ...(electronic > 0n ? [{ methodId: useWallet ? other.methods.wallet : other.methods.card, amount: cop(electronic) }] : []),
          ];
          const before = await balances(other.locationId);
          const { saleId } = await checkout(db, {
            locationId: other.locationId,
            appointmentId,
            extras: extra ? [{ serviceId: other.service, staffId: other.barber2 }] : [],
            discounts: discount > 0n ? [{ key: "appointment", amount: cop(discount), reason: "Prueba" }] : [],
            tips: tip > 0n ? [{ staffId: other.barber, amount: cop(tip) }] : [],
            payments,
            idempotencyKey: key("prop"),
            actor: other.owner,
          });
          const after = await balances(other.locationId);
          const delta = (code: string) => (after.get(code) ?? 0n) - (before.get(code) ?? 0n);
          const sale = await saleDetail(db, other.locationId, saleId);
          // Todo el libro cuadra.
          expect([...after.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
          expect(sale!.totalPaid).toBe(sale!.payments.reduce((a, p) => a + p.amount, 0n));
          expect(sale!.totalPaid).toBe(sale!.lines.reduce((a, l) => a + l.net, 0n) + sale!.tips.reduce((a, t) => a + t.amount, 0n));
          expect(-delta(ACCOUNTS.tipsPayable.code)).toBe(sale!.tips.reduce((a, t) => a + t.payable, 0n));
          expect(delta(ACCOUNTS.cash.code)).toBe(cop(cash).minor);
          for (const l of sale!.lines) expect(l.commission).toBe(((l.net * 4_000n + 500_000n) / 1_000_000n) * 100n);
          expect(delta(ACCOUNTS.commissionExpense.code)).toBe(sale!.lines.reduce((a, l) => a + l.commission, 0n));
          // El cambio es entregado − aplicado y nunca negativo.
          for (const p of sale!.payments) if (p.kind === "cash") expect(p.change).toBe(p.tendered! - p.amount);
        },
      ),
      { numRuns: 12 },
    );
    void money;
  }, 240_000);
});
