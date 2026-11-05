import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { changeStatus, createAppointment } from "./appointments";
import { createService } from "./catalog";
import { findOrCreateClient } from "./clients";
import { createLocation } from "./ledger";
import { DEMAND_CACHE_MS, FEATURED_COUNT, loadPortalData, publicLocation, type PortalData } from "./public-booking";
import { addStaffMember, setWeeklySchedule } from "./staff";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// Portada del portal: "lo más pedido" se cuenta en SQL con las citas tomadas en firme (confirmadas,
// en curso o atendidas) desde hace 60 días; sin citas, vale el orden del catálogo. Además, el "abierto ahora".

const TZ = "America/Bogota";

let db: Db;
let client: PGlite;
let location: bigint;
let barber: bigint;
let clientId: bigint;
const serviceIds = new Map<string, bigint>();
let seq = 0;

async function book(service: string, daysFromToday: number, minute: number): Promise<bigint> {
  const date = addDays(businessDate(new Date(), TZ), daysFromToday);
  const { appointmentId } = await createAppointment(db, {
    locationId: location,
    serviceId: serviceIds.get(service)!,
    staffId: barber,
    start: localMinuteToInstant(date, minute, TZ),
    clientId,
    source: "staff",
    idempotencyKey: `portal-${++seq}`,
    createdBy: "test",
  });
  return appointmentId;
}

async function portal(): Promise<PortalData> {
  const loc = await publicLocation(db, { fallbackToFirst: true });
  return loadPortalData(db, loc!, new Date());
}

const featuredNames = (p: PortalData) => p.featured.map((id) => p.services.find((s) => s.id === id)!.name);

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  location = await createLocation(db, { name: "Villa" });
  barber = await addStaffMember(db, { locationId: location, displayName: "Barbero", role: "barber" });
  await setWeeklySchedule(db, {
    locationId: location,
    staffId: barber,
    blocks: ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: 0, endMin: 1440 })),
  });
  // Creados en este orden: es el orden del catálogo.
  const catalog = [
    ["Corte", 25_000n],
    ["Barba", 15_000n],
    ["Cejas", 8_000n],
    ["Corte + barba", 35_000n],
    ["Mascarilla", 20_000n],
    ["Tinte", 60_000n],
    ["Manicura", 18_000n],
  ] as const;
  for (const [name, price] of catalog) {
    const s = await createService(db, {
      locationId: location,
      draft: { name, durationMin: 30, bufferMin: 0, price: fromUnits(price), commissionBps: 5_000 },
    });
    serviceIds.set(name, s.id);
  }
  clientId = (await findOrCreateClient(db, { locationId: location, name: "Ana", phone: "300 111 2233" })).id;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("portada: lo más pedido", () => {
  it("sin citas: el orden del catálogo, marcado como tal", async () => {
    const p = await portal();
    expect(p.featuredByDemand).toBe(false);
    expect(p.featured).toHaveLength(FEATURED_COUNT);
    expect(featuredNames(p)).toEqual(["Corte", "Barba", "Cejas", "Corte + barba", "Mascarilla", "Tinte"]);
  });

  it("con citas: primero lo más pedido; las canceladas no cuentan", async () => {
    await book("Manicura", 1, 600);
    await book("Manicura", 1, 660);
    await book("Tinte", 1, 720);
    const cancelled = [await book("Barba", 2, 600), await book("Barba", 2, 660), await book("Barba", 2, 720)];
    for (const appointmentId of cancelled) {
      await changeStatus(db, { locationId: location, appointmentId, to: "cancelled", actor: { userId: "user_owner", role: "owner", staffId: barber }, cancelReason: "staff" });
    }
    // Una reserva en línea sin verificar (retención "pending") tampoco cuenta: cualquiera podría
    // inflar el ranking apartando turnos.
    await createAppointment(db, {
      locationId: location,
      serviceId: serviceIds.get("Mascarilla")!,
      staffId: barber,
      start: localMinuteToInstant(addDays(businessDate(new Date(), TZ), 3), 600, TZ),
      clientId,
      source: "online",
      idempotencyKey: `portal-${++seq}`,
      createdBy: "online",
    });
    const p = await portal();
    expect(p.featuredByDemand).toBe(true);
    // Manicura (2), Tinte (1) y después el catálogo; Barba no sube por sus citas canceladas.
    expect(featuredNames(p)).toEqual(["Manicura", "Tinte", "Corte", "Barba", "Cejas", "Corte + barba"]);
  });

  it("con caché (la portada pública): reusa el conteo 5 minutos y después lo refresca", async () => {
    const loc = (await publicLocation(db, { fallbackToFirst: true }))!;
    const t0 = new Date();
    const first = await loadPortalData(db, loc, t0, { cacheDemand: true });
    await book("Cejas", 4, 600);
    await book("Cejas", 4, 660);
    await book("Cejas", 4, 720);
    const cached = await loadPortalData(db, loc, new Date(t0.getTime() + DEMAND_CACHE_MS - 1), { cacheDemand: true });
    expect(featuredNames(cached)).toEqual(featuredNames(first));
    // Sin caché (y pasado el plazo) se ven las citas nuevas.
    expect(featuredNames(await portal())[0]).toBe("Cejas");
    const fresh = await loadPortalData(db, loc, new Date(t0.getTime() + DEMAND_CACHE_MS + 1), { cacheDemand: true });
    expect(featuredNames(fresh)[0]).toBe("Cejas");
  });

  it("los servicios siguen en orden alfabético para la reserva", async () => {
    const list = (await portal()).services.map((s) => s.name);
    expect(list).toEqual([...list].sort((a, b) => a.localeCompare(b, "es")));
  });
});

describe("portada: horario", () => {
  it("abierto todo el día: abierto ahora", async () => {
    const p = await portal();
    expect(p.openNow.open).toBe(true);
    expect(p.openNow.label).toMatch(/^Abierto ahora/);
  });
});
