import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { BookingError } from "@/domain/booking/appointment";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { availability, createAppointment, rescheduleAppointment, walkIn } from "./appointments";
import { createService } from "./catalog";
import { loadPortalData, publicLocation } from "./public-booking";
import { key, setupShop, TZ, type Shop } from "./sales-testing";
import { addStaffMember, serviceIdsByStaff, setStaffServices, setWeeklySchedule, StaffError, staffServiceIds } from "./staff";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// Servicios por profesional: quien no hace un servicio no se ofrece para él (disponibilidad,
// "Cualquiera", walk-in, reprogramar con otro barbero, reserva en línea). Las personas y los
// servicios nuevos nacen con todo asignado, para que nada deje de ofrecerse sin que el dueño lo decida.

let db: Db;
let client: PGlite;
let shop: Shop;
let other: Shop;
let manicure: bigint;
let manicurist: bigint;
const day = () => addDays(businessDate(new Date(), TZ), 3);
const at = (minute: number) => localMinuteToInstant(day(), minute, TZ);
const allDay = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: 0, endMin: 1440 }));

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  shop = await setupShop(db, "Villa");
  other = await setupShop(db, "Otra sede");
  manicure = (
    await createService(db, {
      locationId: shop.locationId,
      draft: { name: "Manicure", durationMin: 45, bufferMin: 5, price: fromUnits(30_000n), commissionBps: 5_000 },
    })
  ).id;
  manicurist = await addStaffMember(db, { locationId: shop.locationId, displayName: "Valentina", role: "barber" });
  await setWeeklySchedule(db, { locationId: shop.locationId, staffId: manicurist, blocks: allDay });
  // Los barberos no hacen manicure; la manicurista solo hace manicure.
  for (const b of [shop.barber, shop.barber2]) await setStaffServices(db, { locationId: shop.locationId, staffId: b, serviceIds: [shop.service] });
  await setStaffServices(db, { locationId: shop.locationId, staffId: manicurist, serviceIds: [manicure] });
}, 120_000);

afterAll(async () => {
  await client?.close();
});

/** Quiénes aparecen libres para un servicio ese día (ids como texto). */
const offered = async (serviceId: bigint, staffId?: bigint) =>
  new Set(
    (await availability(db, { locationId: shop.locationId, serviceId, fromDate: day(), toDate: day(), staffId, internal: true })).flatMap((s) =>
      s.staffIds.map(String),
    ),
  );

describe("asignación por defecto", () => {
  it("una persona nueva hace todos los servicios, y un servicio nuevo lo hace todo el personal", async () => {
    const newcomer = await addStaffMember(db, { locationId: shop.locationId, displayName: "Nuevo", role: "barber" });
    expect(new Set(await staffServiceIds(db, { locationId: shop.locationId, staffId: newcomer }))).toEqual(new Set([shop.service, manicure]));
    const brows = await createService(db, {
      locationId: shop.locationId,
      draft: { name: "Cejas", durationMin: 15, bufferMin: 0, price: fromUnits(4_000n), commissionBps: 5_000 },
    });
    const map = await serviceIdsByStaff(db, shop.locationId);
    for (const s of [shop.barber, shop.barber2, manicurist, newcomer, shop.owner.staffId, shop.reception.staffId]) {
      expect(map.get(s)).toContain(brows.id);
    }
    // El servicio de una sede no se asigna al personal de otra.
    expect((await serviceIdsByStaff(db, other.locationId)).get(other.barber)).not.toContain(brows.id);
  });
});

describe("solo se ofrece quien hace el servicio", () => {
  it("la disponibilidad de manicure solo trae a la manicurista; la de corte, no la trae", async () => {
    expect(await offered(manicure)).toEqual(new Set([manicurist.toString()]));
    const cut = await offered(shop.service);
    expect(cut.has(manicurist.toString())).toBe(false);
    expect(cut.has(shop.barber.toString())).toBe(true);
    expect(await offered(manicure, shop.barber)).toEqual(new Set());
  });

  it("agendar un corte con la manicurista falla con un mensaje claro; con Cualquiera, nunca la elige", async () => {
    const book = (staffId: bigint | "any", minute: number) =>
      createAppointment(db, {
        locationId: shop.locationId,
        serviceId: shop.service,
        staffId,
        start: at(minute),
        clientId: shop.client,
        source: "staff",
        idempotencyKey: key("ss"),
        createdBy: shop.owner.userId,
      });
    await expect(book(manicurist, 9 * 60)).rejects.toThrow("Valentina no hace Corte");
    for (let i = 0; i < 3; i++) {
      const r = await book("any", (10 + i) * 60);
      expect(r.staffId).not.toBe(manicurist);
    }
  });

  it("un walk-in de corte con la manicurista no entra", async () => {
    await expect(
      walkIn(db, {
        locationId: shop.locationId,
        serviceId: shop.service,
        staffId: manicurist,
        clientId: null,
        idempotencyKey: key("wi"),
        createdBy: shop.owner.userId,
      }),
    ).rejects.toThrow(BookingError);
  });

  it("reprogramar a otro barbero exige que haga el servicio; con el mismo, aunque ya no lo haga, sí", async () => {
    const { appointmentId } = await createAppointment(db, {
      locationId: shop.locationId,
      serviceId: shop.service,
      staffId: shop.barber2,
      start: at(15 * 60),
      clientId: shop.client,
      source: "staff",
      idempotencyKey: key("rs"),
      createdBy: shop.owner.userId,
    });
    const move = (staffId: bigint, minute: number) =>
      rescheduleAppointment(db, { locationId: shop.locationId, appointmentId, start: at(minute), staffId, actor: shop.owner });
    await expect(move(manicurist, 16 * 60)).rejects.toThrow("Valentina no hace Corte");
    // Le quitan el corte a barber2 después de agendar: su propia cita se puede mover de hora.
    await setStaffServices(db, { locationId: shop.locationId, staffId: shop.barber2, serviceIds: [] });
    await move(shop.barber2, 17 * 60);
    await setStaffServices(db, { locationId: shop.locationId, staffId: shop.barber2, serviceIds: [shop.service] });
  });

  it("la portada lleva lo que hace cada quien y oculta a quien no hace ningún servicio activo", async () => {
    const loc = await publicLocation(db, { fallbackToFirst: true });
    expect(loc?.id).toBe(shop.locationId);
    const portal = await loadPortalData(db, loc!, new Date());
    const publicOf = (name: string) => portal.services.find((s) => s.name === name)!.id;
    const valentina = portal.staff.find((p) => p.name === "Valentina")!;
    expect(valentina.serviceIds).toContain(publicOf("Manicure"));
    expect(valentina.serviceIds).not.toContain(publicOf("Corte"));
    const andres = portal.staff.find((p) => p.name === "Andrés")!;
    expect(andres.serviceIds).toContain(publicOf("Corte"));
    expect(andres.serviceIds).not.toContain(publicOf("Manicure"));

    const idle = await addStaffMember(db, { locationId: shop.locationId, displayName: "Sin servicios", role: "barber" });
    await setWeeklySchedule(db, { locationId: shop.locationId, staffId: idle, blocks: allDay });
    await setStaffServices(db, { locationId: shop.locationId, staffId: idle, serviceIds: [] });
    expect((await loadPortalData(db, loc!, new Date())).staff.some((p) => p.name === "Sin servicios")).toBe(false);
  });

  it("no se puede asignar un servicio de otra sede", async () => {
    await expect(setStaffServices(db, { locationId: shop.locationId, staffId: manicurist, serviceIds: [other.service] })).rejects.toThrow(StaffError);
    const kept = await staffServiceIds(db, { locationId: shop.locationId, staffId: manicurist });
    expect(kept).toContain(manicure);
    expect(kept).not.toContain(other.service);
  });
});

describe("propiedad", () => {
  it("para cualquier asignación, la disponibilidad trae exactamente a quienes hacen el servicio", async () => {
    const people = [shop.barber, shop.barber2, manicurist];
    const names = people.map(String);
    await fc.assert(
      fc.asyncProperty(fc.array(fc.subarray([shop.service, manicure]), { minLength: 3, maxLength: 3 }), async (assignment) => {
        for (const [i, staffId] of people.entries()) {
          await setStaffServices(db, { locationId: shop.locationId, staffId, serviceIds: assignment[i]! });
        }
        for (const serviceId of [shop.service, manicure]) {
          const doers = new Set(people.filter((_, i) => assignment[i]!.includes(serviceId)).map(String));
          const got = await offered(serviceId);
          for (const s of [...got].filter((id) => names.includes(id))) expect(doers.has(s)).toBe(true);
          for (const d of doers) expect(got.has(d)).toBe(true);
        }
        // Guardar lo mismo otra vez no cambia nada.
        const again = await setStaffServices(db, { locationId: shop.locationId, staffId: manicurist, serviceIds: assignment[2]! });
        expect(again).toEqual({ added: [], removed: [] });
      }),
      { numRuns: 12 },
    );
  });
});
