// Datos de prueba para recorrer la app en local: servicios, cuatro barberos con horario, teléfono de
// la sede y reserva en línea abierta. Se puede ejecutar varias veces: no duplica (busca por nombre).
// No toca el libro contable. Se niega a correr en producción.
// Uso: npm run db:seed-demo
import { and, eq, sql } from "drizzle-orm";
import { fromUnits } from "@/domain/money";
import type { ScheduleBlock, Weekday } from "@/domain/staff/schedule";
import { describeError } from "@/lib/log";
import { createService } from "./catalog";
import { db } from "./client";
import { locationSettings, updateLocationSettings } from "./locations";
import { locations, services, staffMembers } from "./schema";
import { addStaffMember, setWeeklySchedule } from "./staff";
import type { Db } from "./types";

const LOCATION_NAME = "Barbería Villa";
const DEMO_PHONE = "+573122325994"; // Solo para pruebas.

// Precios en pesos enteros; comisión del barbero en puntos básicos (5000 = 50 %).
const SERVICES = [
  { name: "Corte", durationMin: 40, bufferMin: 5, priceUnits: 25_000n, commissionBps: 5000 },
  { name: "Corte + barba", durationMin: 60, bufferMin: 5, priceUnits: 35_000n, commissionBps: 5000 },
  { name: "Barba", durationMin: 30, bufferMin: 5, priceUnits: 15_000n, commissionBps: 5000 },
  { name: "Corte + cera", durationMin: 50, bufferMin: 5, priceUnits: 30_000n, commissionBps: 5000 },
] as const;

const h = (hours: number, minutes = 0) => hours * 60 + minutes;

/** Lunes a sábado con almuerzo; `sunday` agrega un turno corto el domingo. */
function week(start: number, lunch: number, end: number, sunday = false): ScheduleBlock[] {
  const blocks: ScheduleBlock[] = [];
  for (let d = 1; d <= 6; d++) {
    const weekday = d as Weekday;
    blocks.push({ weekday, startMin: start, endMin: lunch }, { weekday, startMin: lunch + 60, endMin: end });
  }
  if (sunday) blocks.push({ weekday: 7 as Weekday, startMin: h(9), endMin: h(14) });
  return blocks;
}

const BARBERS = [
  { name: "Andrés Gómez", schedule: week(h(9), h(13), h(19)) },
  { name: "Camilo Restrepo", schedule: week(h(10), h(14), h(20)) },
  { name: "Julián Ríos", schedule: week(h(9), h(12), h(18), true) },
  { name: "Mateo Cardona", schedule: week(h(11), h(15), h(20), true) },
] as const;

/**
 * tsx no fija NODE_ENV: con el .env de producción, mirar solo NODE_ENV no protege. Se exige una base
 * local (localhost, 127.0.0.1, ::1) o la opción explícita ALLOW_SEED_DEMO=1. Nunca imprime la URL.
 */
function assertDevDatabase(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed-demo es solo para desarrollo: no se ejecuta con NODE_ENV=production");
  }
  if (process.env.ALLOW_SEED_DEMO === "1") return;
  let host = "";
  try {
    host = new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    // Sin URL válida: no es una base local reconocible.
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    throw new Error("seed-demo solo corre contra una base local. Si de verdad es una base de pruebas, usa ALLOW_SEED_DEMO=1.");
  }
}

async function main() {
  assertDevDatabase();
  const client = db();
  const d = client as unknown as Db;

  const [location] = await client.select({ id: locations.id }).from(locations).where(eq(locations.name, LOCATION_NAME));
  if (!location) throw new Error(`No existe la sede "${LOCATION_NAME}". Ejecuta primero: npm run db:seed`);
  const locationId = location.id;

  for (const s of SERVICES) {
    const [found] = await client
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.locationId, locationId), sql`lower(${services.name}) = lower(${s.name})`));
    if (found) {
      console.log(`Servicio "${s.name}": ya existe.`);
      continue;
    }
    await createService(d, {
      locationId,
      draft: { name: s.name, durationMin: s.durationMin, bufferMin: s.bufferMin, price: fromUnits(s.priceUnits), commissionBps: s.commissionBps },
    });
    console.log(`Servicio "${s.name}": creado.`);
  }

  for (const b of BARBERS) {
    const [found] = await client
      .select({ id: staffMembers.id })
      .from(staffMembers)
      .where(and(eq(staffMembers.locationId, locationId), eq(staffMembers.displayName, b.name)));
    if (found) {
      // Un barbero que ya existe conserva su horario: el seed nunca pisa datos reales.
      console.log(`Barbero "${b.name}": ya existe; su horario no se toca.`);
      continue;
    }
    const staffId = await addStaffMember(d, { locationId, displayName: b.name, role: "barber" });
    await setWeeklySchedule(d, { locationId, staffId, blocks: b.schedule });
    console.log(`Barbero "${b.name}": creado con su horario.`);
  }

  const settings = await locationSettings(d, locationId);
  const { name: _name, ...rest } = settings;
  await updateLocationSettings(d, locationId, { ...rest, publicPhone: DEMO_PHONE, publicBookingEnabled: true });
  console.log(`Sede: teléfono ${DEMO_PHONE} y reserva en línea abierta.`);

  await client.$client.end();
}

main().catch((err) => {
  console.error("No se pudieron cargar los datos de prueba:", describeError(err));
  process.exit(1);
});
