import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localMinuteToInstant, MINUTE_MS } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { changeStatus, createAppointment } from "./appointments";
import { clearNoShows, noShowStandingOf } from "./no-shows";
import { key, type Shop, setupShop, TZ } from "./sales-testing";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// Faltas y desbloqueo (src/domain/clients/no-shows.ts). Corre como villa_app, como en el VPS.

let db: Db;
let client: PGlite;
let seq = 0;

beforeAll(async () => {
  ({ db, client } = await createTestDb({ role: "app" }));
}, 120_000);

afterAll(async () => {
  await client?.close();
});

const newShop = () => setupShop(db, `Faltas ${++seq}`);
const one = async <T>(text: string, params: unknown[] = []) => (await client.query<T>(text, params as never[])).rows[0]!;

/** Una cita del cliente marcada "No vino". */
async function markNoShow(shop: Shop, clientId = shop.client): Promise<{ appointmentId: bigint; start: Date }> {
  const start = localMinuteToInstant(addDays(businessDate(new Date(), TZ), 10 + ++seq), 9 * 60, TZ);
  const { appointmentId } = await createAppointment(db, {
    locationId: shop.locationId,
    serviceId: shop.service,
    staffId: shop.barber,
    start,
    clientId,
    source: "staff",
    idempotencyKey: key("appt"),
    createdBy: shop.owner.userId,
  });
  await changeStatus(db, { locationId: shop.locationId, appointmentId, to: "no_show", actor: shop.reception, now: new Date(start.getTime() + 60 * MINUTE_MS) });
  return { appointmentId, start };
}

describe("faltas y reserva en línea", () => {
  it("con 2 faltas queda suspendido; recepción lo desbloquea y queda en la bitácora sin datos de la persona", async () => {
    const shop = await newShop();
    await markNoShow(shop);
    expect(await noShowStandingOf(db, { locationId: shop.locationId, clientId: shop.client, now: new Date() })).toEqual({ count: 1, limit: 2, suspended: false });
    await expect(clearNoShows(db, { locationId: shop.locationId, clientId: shop.client, actor: shop.reception, now: new Date() })).rejects.toThrow(
      "ya puede reservar en línea",
    );
    await markNoShow(shop);
    expect((await noShowStandingOf(db, { locationId: shop.locationId, clientId: shop.client, now: new Date() }))?.suspended).toBe(true);

    await clearNoShows(db, { locationId: shop.locationId, clientId: shop.client, actor: shop.reception, now: new Date() });
    expect(await noShowStandingOf(db, { locationId: shop.locationId, clientId: shop.client, now: new Date() })).toEqual({ count: 0, limit: 2, suspended: false });
    const event = await one<{ action: string; category: string; target_ref: string; summary: string; actor_staff_id: string }>(
      `select action, category, target_ref, summary, actor_staff_id::text from audit_events where location_id = $1 and action = 'client.no_shows_clear'`,
      [String(shop.locationId)],
    );
    expect(event).toEqual({
      action: "client.no_shows_clear",
      category: "personal",
      target_ref: String(shop.client),
      summary: "Desbloqueó la reserva en línea de un cliente (2 faltas)",
      actor_staff_id: String(shop.reception.staffId),
    });

    // Una falta nueva vuelve a contar desde el desbloqueo.
    await markNoShow(shop);
    expect((await noShowStandingOf(db, { locationId: shop.locationId, clientId: shop.client, now: new Date() }))?.count).toBe(1);
  });

  it("una falta que vuelve a \"Llegó\" deja de contar", async () => {
    const shop = await newShop();
    await markNoShow(shop);
    const { appointmentId, start } = await markNoShow(shop);
    await changeStatus(db, { locationId: shop.locationId, appointmentId, to: "arrived", actor: shop.reception, now: new Date(start.getTime() + 90 * MINUTE_MS) });
    expect((await noShowStandingOf(db, { locationId: shop.locationId, clientId: shop.client, now: new Date() }))?.count).toBe(1);
  });

  it("no se desbloquea un cliente de otra sede", async () => {
    const a = await newShop();
    const b = await newShop();
    await markNoShow(b);
    await markNoShow(b);
    await expect(clearNoShows(db, { locationId: a.locationId, clientId: b.client, actor: a.reception, now: new Date() })).rejects.toThrow("no existe en esta sede");
    expect((await noShowStandingOf(db, { locationId: b.locationId, clientId: b.client, now: new Date() }))?.suspended).toBe(true);
  });

  it("el límite sale de la sede", async () => {
    const shop = await newShop();
    await client.query(`update locations set no_show_limit = 3 where id = $1`, [String(shop.locationId)]);
    await markNoShow(shop);
    await markNoShow(shop);
    expect(await noShowStandingOf(db, { locationId: shop.locationId, clientId: shop.client, now: new Date() })).toEqual({ count: 2, limit: 3, suspended: false });
  });
});
