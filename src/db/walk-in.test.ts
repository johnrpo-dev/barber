import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { fromUnits } from "@/domain/money";
import { CheckoutError } from "@/domain/sales/checkout";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import { openCashSession } from "./cash";
import { findOrCreateClient } from "./clients";
import { trialBalance } from "./ledger";
import { checkout, type CheckoutCommand, saleDetail, walkInCheckoutContext } from "./sales";
import { key, type Shop, setupShop } from "./sales-testing";
import { clients, sales } from "./schema";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// Cobro sin cita (walk-in, docs/sprint-4-cobro-caja.md §9.2): los servicios y el barbero se eligen
// en la hoja y el cliente es opcional. Mismo cálculo, mismo asiento, misma idempotencia y la misma
// verificación de totales en la base que el cobro de una cita.

let db: Db;
let client: PGlite;
let shop: Shop;
const cop = (pesos: bigint) => fromUnits(pesos);

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  shop = await setupShop(db, "Walk-in");
  await openCashSession(db, { locationId: shop.locationId, counted: cop(0n), idempotencyKey: key("open"), actor: shop.owner });
}, 120_000);

afterAll(async () => {
  await client?.close();
});

async function balances(locationId: bigint): Promise<Map<string, bigint>> {
  const rows = await trialBalance(db, { locationId });
  return new Map(rows.map((r) => [r.code, r.debits - r.credits]));
}

/** Corte de $30.000 con Andrés, sin cliente, con tarjeta. */
function walkIn(over: Partial<CheckoutCommand> = {}): CheckoutCommand {
  return {
    locationId: shop.locationId,
    appointmentId: null,
    clientId: null,
    extras: [{ serviceId: shop.service, staffId: shop.barber }],
    discounts: [],
    tips: [],
    payments: [{ methodId: shop.methods.card, amount: cop(30_000n) }],
    idempotencyKey: key("walk"),
    actor: shop.reception,
    ...over,
  };
}

describe("walk-in: ejemplos", () => {
  it("dos servicios con dos barberos, propina y efectivo: venta sin cita, asiento cuadrado, en la caja", async () => {
    const before = await balances(shop.locationId);
    const cmd = walkIn({
      extras: [
        { serviceId: shop.service, staffId: shop.barber },
        { serviceId: shop.service, staffId: shop.barber2 },
      ],
      tips: [{ staffId: shop.barber2, amount: cop(5_000n) }],
      payments: [{ methodId: shop.methods.cash, amount: cop(65_000n), tendered: cop(70_000n) }],
    });
    const { saleId } = await checkout(db, cmd);
    const sale = await saleDetail(db, shop.locationId, saleId);
    expect(sale!.totalPaid).toBe(6_500_000n);
    expect(sale!.lines.map((l) => [l.staffId, l.net])).toEqual([
      [shop.barber, 3_000_000n],
      [shop.barber2, 3_000_000n],
    ]);
    const [row] = await db.select({ appointmentId: sales.appointmentId, clientId: sales.clientId }).from(sales).where(eq(sales.id, saleId));
    expect(row).toEqual({ appointmentId: null, clientId: null });
    const after = await balances(shop.locationId);
    expect([...after.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
    expect((after.get(ACCOUNTS.cash.code) ?? 0n) - (before.get(ACCOUNTS.cash.code) ?? 0n)).toBe(6_500_000n);
    // Repetir con la misma clave devuelve la misma venta; con otro contenido, conflicto.
    expect((await checkout(db, cmd)).saleId).toBe(saleId);
    await expect(checkout(db, { ...cmd, tips: [] })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("con cliente: queda en la venta; uno de otra sede no", async () => {
    const { saleId } = await checkout(db, walkIn({ clientId: shop.client }));
    const [row] = await db.select({ clientId: sales.clientId }).from(sales).where(eq(sales.id, saleId));
    expect(row!.clientId).toBe(shop.client);
    const other = await setupShop(db, "Otra sede");
    const theirs = (await findOrCreateClient(db, { locationId: other.locationId, name: "Ajeno", phone: "301 555 0000" })).id;
    await expect(checkout(db, walkIn({ clientId: theirs }))).rejects.toThrow("El cliente no existe en la sede");
  });

  it("cliente nuevo: se crea en la misma transacción del cobro; si el cobro falla, no queda huérfano", async () => {
    const phone = "+573105550101";
    const count = async () => (await db.select({ id: clients.id }).from(clients).where(and(eq(clients.locationId, shop.locationId), eq(clients.phoneE164, phone)))).length;
    const newClient = { name: "Camilo Ruiz", phone: "310 555 0101" };
    // Falta dinero: el cobro se rechaza y el cliente no se crea.
    await expect(checkout(db, walkIn({ newClient, payments: [{ methodId: shop.methods.card, amount: cop(20_000n) }] }))).rejects.toThrow(/Falta dinero/);
    expect(await count()).toBe(0);
    // Con el pago completo, la venta queda con el cliente nuevo; repetir no lo duplica.
    const cmd = walkIn({ newClient });
    const { saleId } = await checkout(db, cmd);
    expect((await checkout(db, cmd)).saleId).toBe(saleId);
    expect(await count()).toBe(1);
    const [row] = await db.select({ clientId: sales.clientId }).from(sales).where(eq(sales.id, saleId));
    expect(row!.clientId).not.toBeNull();
    await expect(checkout(db, walkIn({ newClient, clientId: shop.client }))).rejects.toThrow("Elige un cliente existente o uno nuevo, no los dos");
  });

  it("sin servicios no hay cobro; las claves de descuento deben ser de las líneas de la venta", async () => {
    await expect(checkout(db, walkIn({ extras: [] }))).rejects.toThrow("Elige al menos un servicio");
    const discounted = (k: string) =>
      checkout(db, walkIn({ discounts: [{ key: k, amount: cop(1_000n), reason: "Prueba" }], payments: [{ methodId: shop.methods.card, amount: cop(29_000n) }], actor: shop.owner }));
    for (const bad of ["appointment", "extra:1", "extra:05", "extra:-1", "otra"]) {
      await expect(discounted(bad)).rejects.toBeInstanceOf(CheckoutError);
    }
    await expect(discounted("extra:0")).resolves.toMatchObject({ saleId: expect.any(BigInt) });
  });

  it("el contexto del walk-in trae servicios activos, personal, medios y el estado de la caja", async () => {
    const ctx = await walkInCheckoutContext(db, { locationId: shop.locationId });
    expect(ctx.services.map((s) => s.id)).toContain(shop.service);
    expect(ctx.staff.map((s) => s.id)).toEqual(expect.arrayContaining([shop.barber, shop.barber2]));
    expect(ctx.cashSessionOpen).toBe(true);
    expect(ctx.dayClosed).toBe(false);
  });
});

describe("walk-in: propiedad", () => {
  it("cualquier walk-in válido queda cuadrado: pagado = Σ neto + Σ propinas, una línea por servicio, 1105 sube lo cobrado en efectivo", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ second: fc.boolean(), discount: fc.bigInt({ min: 0n, max: 3_000n }) }), { minLength: 1, maxLength: 4 }),
        fc.bigInt({ min: 0n, max: 15_000n }),
        fc.bigInt({ min: 0n, max: 100n }),
        fc.boolean(),
        async (items, tip, cashShare, withClient) => {
          const net = items.reduce((a, i) => a + 30_000n - i.discount, 0n);
          const total = net + tip;
          const cash = (total * cashShare) / 100n;
          const card = total - cash;
          const before = await balances(shop.locationId);
          const { saleId } = await checkout(db, {
            locationId: shop.locationId,
            appointmentId: null,
            clientId: withClient ? shop.client : null,
            extras: items.map((i) => ({ serviceId: shop.service, staffId: i.second ? shop.barber2 : shop.barber })),
            discounts: items.flatMap((i, n) => (i.discount > 0n ? [{ key: `extra:${n}`, amount: cop(i.discount), reason: "Prueba" }] : [])),
            tips: tip > 0n ? [{ staffId: shop.barber, amount: cop(tip) }] : [],
            payments: [
              ...(cash > 0n ? [{ methodId: shop.methods.cash, amount: cop(cash) }] : []),
              ...(card > 0n ? [{ methodId: shop.methods.card, amount: cop(card) }] : []),
            ],
            idempotencyKey: key("prop-walk"),
            actor: shop.owner,
          });
          const sale = await saleDetail(db, shop.locationId, saleId);
          const after = await balances(shop.locationId);
          expect([...after.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
          expect(sale!.lines).toHaveLength(items.length);
          expect(sale!.totalPaid).toBe(cop(total).minor);
          expect(sale!.totalPaid).toBe(sale!.lines.reduce((a, l) => a + l.net, 0n) + sale!.tips.reduce((a, t) => a + t.amount, 0n));
          for (const l of sale!.lines) expect(l.commission).toBeLessThanOrEqual(l.unitPrice);
          expect((after.get(ACCOUNTS.cash.code) ?? 0n) - (before.get(ACCOUNTS.cash.code) ?? 0n)).toBe(cop(cash).minor);
        },
      ),
      { numRuns: 15 },
    );
  }, 240_000);
});
