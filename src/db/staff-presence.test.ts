import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localMinuteToInstant, MINUTE_MS } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { walkInQueueFor } from "./appointments";
import { setupShop, TZ } from "./sales-testing";
import { staffPresenceEvents } from "./schema";
import { markPresence, presenceToday } from "./staff-presence";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// "Salí / Llegué" (sprint 7). Corre como villa_app, como en el VPS.

let db: Db;
let client: PGlite;
let seq = 0;

beforeAll(async () => {
  ({ db, client } = await createTestDb({ role: "app" }));
}, 120_000);

afterAll(async () => {
  await client?.close();
});

const newShop = () => setupShop(db, `Presencia ${++seq}`);
const dayStart = () => localMinuteToInstant(businessDate(new Date(), TZ), 0, TZ);

describe("Salí / Llegué", () => {
  it("salir y volver; repetir la marca vigente o volver sin haber salido no hace nada", async () => {
    const shop = await newShop();
    const mark = (kind: "out" | "in", staffId = shop.barber) =>
      markPresence(db, { locationId: shop.locationId, staffId, kind, dayStart: dayStart(), createdBy: shop.reception.userId });

    expect(await mark("in")).toEqual({ changed: false });
    expect(await mark("out")).toEqual({ changed: true });
    expect(await mark("out")).toEqual({ changed: false });
    const out = (await presenceToday(db, { locationId: shop.locationId, dayStart: dayStart() })).get(shop.barber);
    expect(out?.outSince).toBeInstanceOf(Date);
    expect(out?.backAt).toBeNull();

    expect(await mark("in")).toEqual({ changed: true });
    expect(await mark("in")).toEqual({ changed: false });
    const back = (await presenceToday(db, { locationId: shop.locationId, dayStart: dayStart() })).get(shop.barber);
    expect(back?.outSince).toBeNull();
    expect(back?.backAt).toBeInstanceOf(Date);
  });

  it("la fila del walk-in: quien salió no entra; al volver queda de último entre los libres", async () => {
    const shop = await newShop();
    // Hora fija (mediodía de hoy): a las 11:50 p. m. el servicio ya no cabe en el turno.
    const at = (h: number, m = 0) => new Date(dayStart().getTime() + (h * 60 + m) * MINUTE_MS);
    const now = at(12);
    const mark = (kind: "out" | "in", when: Date) =>
      db.insert(staffPresenceEvents).values({ locationId: shop.locationId, staffId: shop.barber, kind, at: when, createdBy: shop.reception.userId });
    const queue = async () => walkInQueueFor(db, { locationId: shop.locationId, serviceId: shop.service, now });

    expect((await queue()).find((r) => r.staffId === shop.barber)?.entry.kind).toBe("free");

    await mark("out", at(11));
    expect((await queue()).find((r) => r.staffId === shop.barber)?.entry).toMatchObject({ kind: "excluded", reason: { code: "out", since: at(11) } });

    await mark("in", at(11, 50));
    const free = (await queue()).filter((r) => r.entry.kind === "free");
    expect(free.map((r) => r.staffId)).toContain(shop.barber2);
    expect(free.at(-1)).toMatchObject({ staffId: shop.barber, entry: { freeSince: at(11, 50) } });
  });

  it("una salida de ayer que nadie cerró no lo deja fuera hoy", async () => {
    const shop = await newShop();
    await db.insert(staffPresenceEvents).values({
      locationId: shop.locationId,
      staffId: shop.barber,
      kind: "out",
      at: new Date(dayStart().getTime() - 60 * MINUTE_MS),
      createdBy: shop.reception.userId,
    });
    expect((await presenceToday(db, { locationId: shop.locationId, dayStart: dayStart() })).get(shop.barber)).toBeUndefined();
  });

  it("solo marca personal activo de la misma sede", async () => {
    const a = await newShop();
    const b = await newShop();
    await expect(
      markPresence(db, { locationId: a.locationId, staffId: b.barber, kind: "out", dayStart: dayStart(), createdBy: a.reception.userId }),
    ).rejects.toThrow("no existe en esta sede");
  });

  it("es solo-inserción para la app: no puede cambiar ni borrar marcas", async () => {
    const shop = await newShop();
    await markPresence(db, { locationId: shop.locationId, staffId: shop.barber, kind: "out", dayStart: dayStart(), createdBy: shop.reception.userId });
    await expect(client.query(`update staff_presence_events set kind = 'in' where location_id = $1`, [String(shop.locationId)])).rejects.toThrow(/permission denied/);
    await expect(client.query(`delete from staff_presence_events where location_id = $1`, [String(shop.locationId)])).rejects.toThrow(/permission denied/);
  });
});
