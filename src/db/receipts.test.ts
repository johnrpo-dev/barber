import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveManageToken } from "@/domain/links/manage-token";
import { fromUnits, money } from "@/domain/money";
import { MemoryNotifier } from "@/lib/notify/memory";
import { bucketHash } from "@/lib/public-readiness";
import { openCashSession } from "./cash";
import { type DeliveryContext, deliverNotification } from "./notifications";
import { enqueueSaleReceipt, saleReceipt, salesOfDay } from "./receipts";
import { checkout } from "./sales";
import { key, quickSale, setupShop, type Shop } from "./sales-testing";
import { notificationEvents, notifications, sales } from "./schema";
import { createTestDb } from "./testing";
import type { Db } from "./types";
import { decideVoid, requestVoid } from "./voids";

// Recibo de una venta: lectura sin datos del cliente, aislamiento por sede, y envío al cliente por
// el outbox (una sola vez por venta, nunca de una venta anulada ni sin cliente).

const PEPPER = "p".repeat(40);
const hash = (v: string) => bucketHash(v, PEPPER);

let db: Db;
let client: PGlite;
let shop: Shop;
let other: Shop;

const ctx: DeliveryContext = {
  hash,
  manageUrl: (publicId, generation) => `https://villa.test/cita/${deriveManageToken("s".repeat(40), publicId, generation)}`,
  bookingUrl: "https://villa.test/reservar",
  caps: { perRecipientPerDay: 100, globalPerDay: 1000 },
  channels: ["whatsapp", "email"],
};

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  shop = await setupShop(db, "Villa");
  other = await setupShop(db, "Otra sede");
}, 120_000);

afterAll(async () => {
  await client?.close();
});

async function publicIdOf(saleId: bigint): Promise<string> {
  const [row] = await db.select({ publicId: sales.publicId }).from(sales).where(eq(sales.id, saleId));
  return row!.publicId;
}

async function receiptNotifications(publicId: string) {
  return db
    .select({ id: notifications.id, channel: notifications.channel, params: notifications.params, clientId: notifications.clientId })
    .from(notifications)
    .where(and(eq(notifications.locationId, shop.locationId), eq(notifications.dedupeKey, `sale_receipt:${publicId}`)));
}

async function voidSale(saleId: bigint) {
  const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Se cobró dos veces", idempotencyKey: key("void"), actor: shop.reception });
  await decideVoid(db, { locationId: shop.locationId, requestId, approve: true, note: "", idempotencyKey: key("decide"), approver: shop.owner });
}

describe("recibo de una venta", () => {
  it("trae lo guardado al cobrar, con quién atendió y sin el cliente", async () => {
    const { saleId } = await quickSale(db, shop, { kind: "card", tip: 2_000n });
    const publicId = await publicIdOf(saleId);
    const r = await saleReceipt(db, { locationId: shop.locationId, publicId });
    expect(r).toMatchObject({ publicId, status: "paid", totalPaid: fromUnits(32_000n).minor, location: { name: "Villa" } });
    expect(r!.lines).toEqual([expect.objectContaining({ description: "Corte", staffName: "Andrés", net: fromUnits(30_000n).minor })]);
    expect(r!.tipLines).toEqual([{ staffName: "Andrés", amount: fromUnits(2_000n).minor }]);
    // El celular se busca en E.164: "300" solo también aparece dentro de los montos en centavos.
    expect(JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/Juan|Pérez|\+57300/);
  });

  it("otra sede no la encuentra", async () => {
    const { saleId } = await quickSale(db, shop);
    const publicId = await publicIdOf(saleId);
    expect(await saleReceipt(db, { locationId: other.locationId, publicId })).toBeNull();
  });

  it("las ventas del día: de la más reciente a la más antigua, solo de esta sede", async () => {
    const first = await publicIdOf((await quickSale(db, shop)).saleId);
    const second = await publicIdOf((await quickSale(db, shop)).saleId);
    const r = await saleReceipt(db, { locationId: shop.locationId, publicId: second });
    const list = await salesOfDay(db, { locationId: shop.locationId, businessDate: r!.businessDate });
    const ids = list.map((s) => s.publicId);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
    expect(list.find((s) => s.publicId === second)).toMatchObject({ services: ["Corte"], staffNames: ["Andrés"], status: "paid" });
    const theirs = await salesOfDay(db, { locationId: other.locationId, businessDate: r!.businessDate });
    expect(theirs.map((s) => s.publicId)).not.toContain(second);
  });
});

describe("enviar el recibo al cliente", () => {
  it("queda en cola por WhatsApp con el resumen, una sola vez aunque se pida dos veces", async () => {
    const { saleId } = await quickSale(db, shop, { kind: "card" });
    const publicId = await publicIdOf(saleId);
    expect(await enqueueSaleReceipt(db, { locationId: shop.locationId, publicId, channels: ["whatsapp", "email"], hash })).toBe("whatsapp");
    expect(await enqueueSaleReceipt(db, { locationId: shop.locationId, publicId, channels: ["whatsapp", "email"], hash })).toBe("whatsapp");
    const rows = await receiptNotifications(publicId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "whatsapp", clientId: shop.client });
    expect(rows[0]!.params).toMatchObject({ name: "Juan", number: publicId.slice(-8), items: "Corte" });
    expect(rows[0]!.params.total).toMatch(/30\.000/);
    // Solo el primer nombre: ni apellido ni celular en los parámetros guardados.
    expect(JSON.stringify(rows[0]!.params)).not.toMatch(/Pérez|\+57300|300 123/);
  });

  it("el worker lo entrega al celular del cliente", async () => {
    const { saleId } = await quickSale(db, shop, { kind: "card" });
    const publicId = await publicIdOf(saleId);
    await enqueueSaleReceipt(db, { locationId: shop.locationId, publicId, channels: ["whatsapp"], hash });
    const [row] = await receiptNotifications(publicId);
    const notifier = new MemoryNotifier();
    expect(await deliverNotification(db, row!.id, notifier, ctx)).toBe("sent");
    expect(notifier.sent).toEqual([expect.objectContaining({ channel: "whatsapp", template: "sale_receipt", to: "+573001234567" })]);
    // A lo sumo una vez.
    expect(await deliverNotification(db, row!.id, notifier, ctx)).toBe("skipped");
    expect(notifier.sent).toHaveLength(1);
  });

  it("si la venta se anula antes de salir, no se manda", async () => {
    const { saleId } = await quickSale(db, shop, { kind: "card" });
    const publicId = await publicIdOf(saleId);
    await enqueueSaleReceipt(db, { locationId: shop.locationId, publicId, channels: ["whatsapp"], hash });
    await voidSale(saleId);
    const [row] = await receiptNotifications(publicId);
    const notifier = new MemoryNotifier();
    expect(await deliverNotification(db, row!.id, notifier, ctx)).toBe("suppressed");
    expect(notifier.sent).toEqual([]);
    const events = await db.select({ kind: notificationEvents.kind, code: notificationEvents.errorCode }).from(notificationEvents).where(eq(notificationEvents.notificationId, row!.id));
    expect(events).toEqual([{ kind: "suppressed", code: "sale_not_paid" }]);
  });

  it("una venta anulada, sin cliente o sin un canal para su contacto no encola nada", async () => {
    const { saleId } = await quickSale(db, shop, { kind: "card" });
    const voided = await publicIdOf(saleId);
    await voidSale(saleId);
    expect(await enqueueSaleReceipt(db, { locationId: shop.locationId, publicId: voided, channels: ["whatsapp"], hash })).toBeNull();

    // El cliente de prueba tiene celular pero no correo.
    const { saleId: other2 } = await quickSale(db, shop, { kind: "card" });
    const onlyEmail = await publicIdOf(other2);
    expect(await enqueueSaleReceipt(db, { locationId: shop.locationId, publicId: onlyEmail, channels: ["email"], hash })).toBeNull();

    await openCashSession(db, { locationId: shop.locationId, counted: fromUnits(0n), idempotencyKey: key("open"), actor: shop.owner }).catch(() => undefined);
    const walkIn = await checkout(db, {
      locationId: shop.locationId,
      appointmentId: null,
      clientId: null,
      extras: [{ serviceId: shop.service, staffId: shop.barber }],
      discounts: [],
      tips: [],
      payments: [{ methodId: shop.methods.card, amount: money(fromUnits(30_000n).minor) }],
      idempotencyKey: key("walkin"),
      actor: shop.reception,
    });
    const anonymous = await publicIdOf(walkIn.saleId);
    expect(await enqueueSaleReceipt(db, { locationId: shop.locationId, publicId: anonymous, channels: ["whatsapp", "email"], hash })).toBeNull();
    expect(await receiptNotifications(anonymous)).toEqual([]);

    // Otra sede no encola el recibo de esta.
    const { saleId: mine } = await quickSale(db, shop, { kind: "card" });
    expect(await enqueueSaleReceipt(db, { locationId: other.locationId, publicId: await publicIdOf(mine), channels: ["whatsapp"], hash })).toBeNull();
  });
});
