import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits, type Money } from "@/domain/money";
import { CheckoutError } from "@/domain/sales/checkout";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import { openCashSession } from "./cash";
import { accountBalance, postEntry } from "./ledger";
import { createProduct, setProductActive } from "./products";
import { saleReceipt } from "./receipts";
import { salesByService, salesByStaff } from "./reports";
import { checkout, type CheckoutCommand, saleDetail, walkInCheckoutContext } from "./sales";
import { chairAppointment, key, type Shop, setupShop, TZ } from "./sales-testing";
import { cashMovements, saleLines, salePayments, sales } from "./schema";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";
import { decideVoid, requestVoid } from "./voids";

// Sprint 6, fase C (docs/sprint-6-productos-inventario.md): vender productos en el cobro. Las líneas
// de producto llevan unidades y su neto va a 4135; las de servicio, a 4170. No mueven costo ni
// inventario (1435 y 6135 quedan quietos hasta el conteo). La base lo exige al hacer COMMIT (0034).

let db: Db;
let client: PGlite;
let shop: Shop;
let cera: bigint;
let aceite: bigint;
const cop = (pesos: bigint): Money => fromUnits(pesos);
const today = () => businessDate(new Date(), TZ);

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  shop = await setupShop(db, "Productos");
  await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key("open"), actor: shop.owner });
  // Cera a $25.000 con 10 % para quien la vende; aceite a $40.000 sin comisión.
  cera = (await createProduct(db, { locationId: shop.locationId, draft: { name: "Cera", sku: null, price: cop(25_000n), commissionBps: 1_000 } })).id;
  aceite = (await createProduct(db, { locationId: shop.locationId, draft: { name: "Aceite", sku: null, price: cop(40_000n), commissionBps: 0 } })).id;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

const balance = (code: string, s: Shop = shop) => accountBalance(db, s.locationId, code as never);

/** Venta de mostrador: solo productos, sin cita y sin cliente. */
function counter(over: Partial<CheckoutCommand> = {}): CheckoutCommand {
  return {
    locationId: shop.locationId,
    appointmentId: null,
    clientId: null,
    extras: [],
    products: [{ productId: cera, quantity: 2, staffId: shop.reception.staffId }],
    discounts: [],
    tips: [],
    payments: [{ methodId: shop.methods.cash, amount: cop(50_000n) }],
    idempotencyKey: key("mostrador"),
    actor: shop.reception,
    ...over,
  };
}

describe("vender productos: ejemplos", () => {
  it("cita + dos ceras con descuento: 4170 el corte, 4135 las ceras, comisión a quien vendió, sin tocar inventario", async () => {
    const before = { s: await balance("4170"), p: await balance("4135"), inv: await balance("1435"), cogs: await balance("6135") };
    const appointmentId = await chairAppointment(db, shop);
    const { saleId } = await checkout(db, {
      locationId: shop.locationId,
      appointmentId,
      extras: [],
      products: [{ productId: cera, quantity: 2, staffId: shop.barber2 }],
      discounts: [{ key: "product:0", amount: cop(5_000n), reason: "Lleva dos" }],
      tips: [],
      payments: [{ methodId: shop.methods.card, amount: cop(75_000n) }],
      idempotencyKey: key("mixta"),
      actor: shop.owner,
    });
    expect(await balance("4170")).toBe(before.s - cop(30_000n).minor);
    expect(await balance("4135")).toBe(before.p - cop(45_000n).minor);
    expect(await balance("1435")).toBe(before.inv);
    expect(await balance("6135")).toBe(before.cogs);

    const sale = await saleDetail(db, shop.locationId, saleId);
    expect(sale!.lines).toMatchObject([
      { kind: "service", quantity: 1, description: "Corte", staffId: shop.barber, net: cop(30_000n).minor },
      // Bruto 2 × $25.000 − $5.000; comisión 10 % del neto para Bruno, que la vendió.
      { kind: "product", quantity: 2, description: "Cera", staffId: shop.barber2, unitPrice: cop(25_000n).minor, net: cop(45_000n).minor, commission: cop(4_500n).minor },
    ]);
    const [row] = await db.select().from(sales).where(eq(sales.id, saleId));
    expect(row).toMatchObject({ subtotal: cop(80_000n).minor, discount: cop(5_000n).minor, totalPaid: cop(75_000n).minor });

    const receipt = await saleReceipt(db, { locationId: shop.locationId, publicId: row!.publicId });
    expect(receipt!.lines[1]).toMatchObject({ description: "Cera", quantity: 2, net: cop(45_000n).minor });
  });

  it("venta de mostrador solo de productos, en efectivo: entra a la caja y no toca 4170", async () => {
    const before4170 = await balance("4170");
    const before4135 = await balance("4135");
    const { saleId } = await checkout(db, counter());
    expect(await balance("4170")).toBe(before4170);
    expect(await balance("4135")).toBe(before4135 - cop(50_000n).minor);
    const [row] = await db.select().from(sales).where(eq(sales.id, saleId));
    expect(row!.clientId).toBeNull();
    const [movement] = await db
      .select()
      .from(cashMovements)
      .where(and(eq(cashMovements.locationId, shop.locationId), eq(cashMovements.journalEntryId, row!.journalEntryId)));
    expect(movement).toMatchObject({ kind: "sale", description: "Venta: Cera ×2" });
  });

  it("la misma clave devuelve la misma venta; con otros productos es un conflicto", async () => {
    const cmd = counter({ products: [{ productId: aceite, quantity: 1, staffId: shop.barber }], payments: [{ methodId: shop.methods.card, amount: cop(40_000n) }] });
    const first = await checkout(db, cmd);
    expect(await checkout(db, cmd)).toEqual({ saleId: first.saleId, created: false });
    await expect(checkout(db, { ...cmd, products: [{ productId: aceite, quantity: 2, staffId: shop.barber }] })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it("rechaza un producto retirado, de otra sede, un descuento sin línea y cantidades imposibles", async () => {
    const retirado = (await createProduct(db, { locationId: shop.locationId, draft: { name: "Retirado", sku: null, price: cop(10_000n), commissionBps: 0 } })).id;
    await setProductActive(db, { locationId: shop.locationId, productId: retirado, active: false });
    const pay = (pesos: bigint) => [{ methodId: shop.methods.card, amount: cop(pesos) }];
    await expect(checkout(db, counter({ products: [{ productId: retirado, quantity: 1, staffId: shop.barber }], payments: pay(10_000n) }))).rejects.toThrow(
      /ya no se vende/,
    );

    const other = await setupShop(db, "Otra sede de productos");
    const ajeno = (await createProduct(db, { locationId: other.locationId, draft: { name: "Ajeno", sku: null, price: cop(10_000n), commissionBps: 0 } })).id;
    await expect(checkout(db, counter({ products: [{ productId: ajeno, quantity: 1, staffId: shop.barber }], payments: pay(10_000n) }))).rejects.toThrow(
      /no existe/,
    );
    // Quien vende debe ser de la sede.
    await expect(checkout(db, counter({ products: [{ productId: cera, quantity: 1, staffId: other.barber }], payments: pay(25_000n) }))).rejects.toThrow(
      /no está activa/,
    );
    await expect(
      checkout(db, counter({ discounts: [{ key: "product:1", amount: cop(1_000n), reason: "x" }], payments: pay(49_000n) })),
    ).rejects.toThrow(/no corresponde a ninguna línea/);
    for (const quantity of [0, 100, 1.5]) {
      await expect(checkout(db, counter({ products: [{ productId: cera, quantity, staffId: shop.barber }] }))).rejects.toBeInstanceOf(CheckoutError);
    }
    // Un walk-in vacío no se cobra.
    await expect(checkout(db, counter({ products: [] }))).rejects.toThrow(/al menos un servicio o un producto/);
  });

  it("la hoja de cobro trae solo los productos activos de la sede", async () => {
    const ctx = await walkInCheckoutContext(db, { locationId: shop.locationId });
    const names = ctx.products.map((p) => p.name);
    expect(names).toContain("Cera");
    expect(names).toContain("Aceite");
    expect(names).not.toContain("Retirado");
    expect(names).not.toContain("Ajeno");
  });
});

describe("anular e informes", () => {
  it("anular una venta con productos devuelve 4135 y su comisión; los informes separan servicios y productos", async () => {
    const s = await setupShop(db, "Anular productos");
    const gel = (await createProduct(db, { locationId: s.locationId, draft: { name: "Gel", sku: null, price: cop(20_000n), commissionBps: 1_000 } })).id;
    const appointmentId = await chairAppointment(db, s);
    const { saleId } = await checkout(db, {
      locationId: s.locationId,
      appointmentId,
      extras: [],
      products: [{ productId: gel, quantity: 3, staffId: s.barber2 }],
      discounts: [],
      tips: [],
      payments: [{ methodId: s.methods.card, amount: cop(90_000n) }],
      idempotencyKey: key("anular"),
      actor: s.owner,
    });
    const q = { locationId: s.locationId, from: today(), to: today() };
    const byStaff = await salesByStaff(db, q);
    expect(byStaff.find((r) => r.staffId === s.barber)).toMatchObject({ services: 1, net: cop(30_000n).minor, productsNet: 0n });
    // Bruno no hizo servicios: vendió tres geles y se lleva su comisión.
    expect(byStaff.find((r) => r.staffId === s.barber2)).toMatchObject({ services: 0, net: 0n, productsNet: cop(60_000n).minor, commission: cop(6_000n).minor });
    expect(await salesByService(db, q)).toMatchObject([{ name: "Corte", services: 1, net: cop(30_000n).minor }]);

    const { requestId } = await requestVoid(db, { locationId: s.locationId, saleId, reason: "Error", idempotencyKey: key("v"), actor: s.reception });
    await decideVoid(db, { locationId: s.locationId, requestId, approve: true, note: "", idempotencyKey: key("d"), approver: s.owner });
    for (const code of ["4170", "4135", "5105", "2335", "1110"]) expect(await balance(code, s)).toBe(0n);
    // Venta y anulación el mismo día: el informe queda vacío.
    expect(await salesByStaff(db, q)).toEqual([]);
  });
});

describe("la base exige el cuadre de productos al hacer COMMIT (0034)", () => {
  /** Una venta armada a mano con un asiento y una línea a elección. */
  function forge(opts: {
    entry: { account: string; side: "debit" | "credit"; pesos: bigint }[];
    line: Partial<typeof saleLines.$inferInsert>;
  }) {
    const day = today();
    return db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const posted = await postEntry(tx, {
        locationId: shop.locationId,
        createdBy: "x",
        entry: {
          businessDate: day,
          kind: "sale",
          memo: "a mano",
          lines: opts.entry.map((l) => ({ account: l.account as never, side: l.side, amount: cop(l.pesos) })),
        },
      });
      const [sale] = await tx
        .insert(sales)
        .values({
          locationId: shop.locationId,
          publicId: key("f"),
          appointmentId: null,
          businessDate: day,
          journalEntryId: posted.entryId,
          // Precio × unidades: con unit_price sumado sin unidades no cuadraría.
          subtotal: cop(50_000n).minor,
          discount: 0n,
          tips: 0n,
          totalPaid: cop(50_000n).minor,
          createdBy: "x",
          idempotencyKey: key(),
          requestHash: "0".repeat(64),
        })
        .returning({ id: sales.id });
      await tx.insert(saleLines).values({
        locationId: shop.locationId,
        saleId: sale!.id,
        position: 0,
        kind: "product",
        productId: cera,
        quantity: 2,
        staffId: shop.barber,
        description: "Cera",
        unitPrice: cop(25_000n).minor,
        discount: 0n,
        net: cop(50_000n).minor,
        commissionBps: 0,
        commission: 0n,
        ...opts.line,
      });
      await tx.insert(salePayments).values({
        locationId: shop.locationId,
        saleId: sale!.id,
        methodId: shop.methods.card,
        kind: "card",
        label: "Tarjeta",
        feeBps: 0,
        amount: cop(50_000n).minor,
        fee: 0n,
      });
    });
  }
  const bank = { account: ACCOUNTS.bank.code, side: "debit" as const, pesos: 50_000n };

  it("una venta de producto va a 4135, nunca a 4170, y su asiento no toca otras cuentas", async () => {
    // El ingreso del producto en 4170: no coincide con las líneas.
    expect(await dbError(forge({ entry: [bank, { account: "4170", side: "credit", pesos: 50_000n }], line: {} }))).toMatch(/no coincide/);
    // Un par de líneas fuera de las cuentas de venta (gasto contra capital) que se anulan entre sí.
    expect(
      await dbError(
        forge({
          entry: [bank, { account: "4135", side: "credit", pesos: 50_000n }, { account: "5195", side: "debit", pesos: 1_000n }, { account: "3105", side: "credit", pesos: 1_000n }],
          line: {},
        }),
      ),
    ).toMatch(/no es de ventas/);
    // Con todo consistente, la base la acepta.
    await expect(forge({ entry: [bank, { account: "4135", side: "credit", pesos: 50_000n }], line: {} })).resolves.toBeUndefined();
  });

  it("una línea es servicio o producto, nunca los dos ni ninguno, con unidades sensatas", async () => {
    const ok = [bank, { account: "4135", side: "credit" as const, pesos: 50_000n }];
    expect(await dbError(forge({ entry: ok, line: { serviceId: shop.service } }))).toMatch(/item_check/);
    expect(await dbError(forge({ entry: ok, line: { productId: null } }))).toMatch(/item_check/);
    expect(await dbError(forge({ entry: ok, line: { quantity: 100, unitPrice: 50_000n, net: cop(50_000n).minor } }))).toMatch(/item_check/);
    // Un servicio va de a uno.
    expect(await dbError(forge({ entry: ok, line: { kind: "service", productId: null, serviceId: shop.service } }))).toMatch(/item_check/);
    // El neto es precio × unidades − descuento.
    expect(await dbError(forge({ entry: ok, line: { net: cop(25_000n).minor } }))).toMatch(/amounts_check/);
  });
});

describe("propiedades: productos y servicios en el libro", () => {
  it("para cualquier mezcla de ventas y anulaciones, 4170 y 4135 son la suma de sus líneas vigentes y 1435 no se mueve", async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            withService: fc.boolean(),
            items: fc.array(fc.record({ product: fc.constantFrom(0, 1), quantity: fc.integer({ min: 1, max: 5 }), discountPct: fc.integer({ min: 0, max: 30 }) }), {
              maxLength: 3,
            }),
            voided: fc.boolean(),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (plan) => {
          const s = await setupShop(db, `Propiedad productos ${++run}`);
          const prods = [
            (await createProduct(db, { locationId: s.locationId, draft: { name: "Cera", sku: null, price: cop(25_000n), commissionBps: 1_000 } })).id,
            (await createProduct(db, { locationId: s.locationId, draft: { name: "Aceite", sku: null, price: cop(33_000n), commissionBps: 500 } })).id,
          ];
          const prices = [25_000n, 33_000n];
          let services = 0n;
          let productsNet = 0n;
          for (const sale of plan) {
            if (!sale.withService && sale.items.length === 0) continue;
            const discounts = sale.items
              .map((it, i) => {
                // Descuento en pesos enteros, truncado por debajo del tope del 30 %.
                const pesos = (prices[it.product]! * BigInt(it.quantity) * BigInt(it.discountPct)) / 100n;
                return { key: `product:${i}`, amount: cop(pesos), reason: "promo" };
              })
              .filter((d) => d.amount.minor > 0n);
            const gross = sale.items.reduce((a, it) => a + prices[it.product]! * BigInt(it.quantity), 0n);
            const off = discounts.reduce((a, d) => a + d.amount.minor, 0n) / 100n;
            const due = gross - off + (sale.withService ? 30_000n : 0n);
            const { saleId } = await checkout(db, {
              locationId: s.locationId,
              appointmentId: sale.withService ? await chairAppointment(db, s) : null,
              clientId: sale.withService ? undefined : null,
              extras: [],
              products: sale.items.map((it) => ({ productId: prods[it.product]!, quantity: it.quantity, staffId: s.barber2 })),
              discounts,
              tips: [],
              payments: [{ methodId: s.methods.card, amount: cop(due) }],
              idempotencyKey: key("prop"),
              actor: s.owner,
            });
            if (sale.voided) {
              const { requestId } = await requestVoid(db, { locationId: s.locationId, saleId, reason: "x", idempotencyKey: key("v"), actor: s.reception });
              await decideVoid(db, { locationId: s.locationId, requestId, approve: true, note: "", idempotencyKey: key("d"), approver: s.owner });
            } else {
              services += sale.withService ? cop(30_000n).minor : 0n;
              productsNet += cop(gross - off).minor;
            }
          }
          expect(await balance("4170", s)).toBe(-services);
          expect(await balance("4135", s)).toBe(-productsNet);
          expect(await balance("1435", s)).toBe(0n);
          expect(await balance("6135", s)).toBe(0n);
          // Los informes suman lo mismo que el libro.
          const byStaff = await salesByStaff(db, { locationId: s.locationId, from: today(), to: today() });
          expect(byStaff.reduce((a, r) => a + r.net, 0n)).toBe(services);
          expect(byStaff.reduce((a, r) => a + r.productsNet, 0n)).toBe(productsNet);
        },
      ),
      { numRuns: 8 },
    );
  }, 300_000);
});
