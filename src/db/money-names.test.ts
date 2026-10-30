import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDate } from "@/domain/ledger/business-date";
import { daySales, ledgerCash, openCashSession, sessionSummary } from "./cash";
import { checkout, saleDetail } from "./sales";
import { chairAppointment, key, setupShop, simpleCheckout, TZ } from "./sales-testing";
import { user } from "./schema";
import { createStaffUser } from "./staff";
import { createTestDb } from "./testing";
import type { Db } from "./types";
import { requestVoid, voidQueue } from "./voids";
import { money } from "@/domain/money";

// Quién cobró, abrió la caja o pidió una anulación se muestra con el nombre que el dueño le puso en
// la sede (staff_members.display_name), nunca con el nombre de la cuenta (user.name), que cada
// quien podría cambiarse para culpar a otro.

let db: Db;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("nombres en las vistas de dinero", () => {
  it("usan el nombre en la sede aunque el de la cuenta cambie", { timeout: 60_000 }, async () => {
    const shop = await setupShop(db, "Nombres");
    const { userId, staffId } = await createStaffUser(db, {
      locationId: shop.locationId,
      name: "Ana Recepción",
      email: "ana-nombres@villa.test",
      password: "clave-de-prueba-123", // valor de prueba, solo existe en esta base en memoria
      role: "reception",
    });
    await db.update(user).set({ name: "Otro Nombre" }).where(eq(user.id, userId));
    const actor = { userId, role: "reception" as const, staffId };

    await openCashSession(db, { locationId: shop.locationId, counted: money(await ledgerCash(db, shop.locationId)), idempotencyKey: key("abrir"), actor });
    const appointmentId = await chairAppointment(db, shop);
    const { saleId } = await checkout(db, { ...simpleCheckout(shop, appointmentId), actor });
    await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Se cobró dos veces", idempotencyKey: key("anular"), actor });

    expect((await sessionSummary(db, shop.locationId))?.openedBy).toBe("Ana Recepción");
    const sales = await daySales(db, shop.locationId, businessDate(new Date(), TZ));
    expect(sales.find((s) => s.saleId === saleId)?.chargedBy).toBe("Ana Recepción");
    expect((await saleDetail(db, shop.locationId, saleId))?.chargedByName).toBe("Ana Recepción");
    const [row] = await voidQueue(db, { locationId: shop.locationId });
    expect(row).toMatchObject({ requestedBy: "Ana Recepción", chargedBy: "Ana Recepción" });
  });
});
