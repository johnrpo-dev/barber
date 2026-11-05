import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { appointmentsToCharge } from "./cash";
import { checkout } from "./sales";
import { chairAppointment, setupShop, simpleCheckout, TZ, type Shop } from "./sales-testing";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// "Por cobrar" de la caja: las citas del día en la silla o terminadas que aún no tienen una venta
// pagada. Una cita cobrada sale de la lista; nada se cruza entre sedes ni entre días.

let db: Db;
let client: PGlite;
let shop: Shop;
let other: Shop;
let day: string;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  shop = await setupShop(db, "Villa");
  other = await setupShop(db, "Otra sede");
  // chairAppointment agenda las primeras 20 citas dos días adelante.
  day = addDays(businessDate(new Date(), TZ), 2);
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("citas por cobrar", () => {
  it("lista las citas en la silla o terminadas sin cobrar, en orden de hora; la cobrada sale", async () => {
    const inChair = await chairAppointment(db, shop);
    const finished = await chairAppointment(db, shop, { completed: true, staffId: shop.barber2 });
    const charged = await chairAppointment(db, shop);
    await checkout(db, simpleCheckout(shop, charged));
    await chairAppointment(db, other);

    const rows = await appointmentsToCharge(db, shop.locationId, day);
    expect(rows.map((r) => r.appointmentId)).toEqual([inChair, finished]);
    expect(rows[0]).toMatchObject({ status: "in_chair", clientName: "Juan Pérez", serviceName: "Corte", staffName: "Andrés", price: fromUnits(30_000n).minor });
    expect(rows[1]).toMatchObject({ status: "completed", staffName: "Bruno" });
    expect(rows[0]!.start.getTime()).toBeLessThan(rows[1]!.start.getTime());
  });

  it("otro día no trae nada", async () => {
    expect(await appointmentsToCharge(db, shop.locationId, addDays(day, 1))).toEqual([]);
  });

  it("cada sede ve solo sus citas", async () => {
    const rows = await appointmentsToCharge(db, other.locationId, day);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.staffName).toBe("Andrés");
  });
});
