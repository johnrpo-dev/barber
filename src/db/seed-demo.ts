// Datos de prueba para recorrer la app en local: servicios, diez barberos con horario, teléfono de
// la sede, reserva en línea abierta y dos cuentas de prueba (recepción y barbero) para ver el panel
// como cada rol. Se puede ejecutar varias veces: no duplica (busca por nombre).
// No toca el libro contable. Se niega a correr en producción.
// Uso: npm run db:seed-demo
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Role } from "@/domain/staff/roles";
import { fromUnits } from "@/domain/money";
import type { ScheduleBlock, Weekday } from "@/domain/staff/schedule";
import { describeError } from "@/lib/log";
import { createService } from "./catalog";
import { db } from "./client";
import { locationSettings, updateLocationSettings } from "./locations";
import { locations, services, staffMembers, user } from "./schema";
import { addStaffMember, createStaffUser, setWeeklySchedule } from "./staff";
import type { Db } from "./types";

const LOCATION_NAME = "Barbería Villa";
const DEMO_PHONE = "+573122325994"; // Solo para pruebas.

// Catálogo de la demo: los servicios que Barbería Villa publica hoy en su página de reservas (precio y
// duración de nov. 2026), en el orden de lo más pedido allá: sin citas, la portada usa este orden.
// Precios en pesos enteros; comisión del barbero en puntos básicos (5000 = 50 %).
const SERVICES = [
  { name: "Corte de cabello hombre o niño", durationMin: 30, bufferMin: 5, priceUnits: 22_000n, commissionBps: 5000 },
  { name: "Corte de cabello y barba", durationMin: 60, bufferMin: 5, priceUnits: 30_000n, commissionBps: 5000 },
  { name: "Manicure tradicional dama", durationMin: 45, bufferMin: 5, priceUnits: 30_000n, commissionBps: 5000 },
  { name: "Corte de cabello y barba (tarjeta Gold)", durationMin: 60, bufferMin: 5, priceUnits: 28_000n, commissionBps: 5000 },
  { name: "Pedicure tradicional dama", durationMin: 50, bufferMin: 5, priceUnits: 30_000n, commissionBps: 5000 },
  { name: "Corte de cabello (tarjeta Gold)", durationMin: 35, bufferMin: 5, priceUnits: 20_000n, commissionBps: 5000 },
  { name: "Pigmento en barba", durationMin: 20, bufferMin: 5, priceUnits: 12_000n, commissionBps: 5000 },
  { name: "Cejas con cuchilla", durationMin: 15, bufferMin: 0, priceUnits: 4_000n, commissionBps: 5000 },
  { name: "Aplicación de tinte", durationMin: 20, bufferMin: 5, priceUnits: 13_000n, commissionBps: 5000 },
  { name: "Barba con vapor", durationMin: 35, bufferMin: 5, priceUnits: 20_000n, commissionBps: 5000 },
  { name: "Barba sencilla", durationMin: 30, bufferMin: 5, priceUnits: 15_000n, commissionBps: 5000 },
  { name: "Barba sencilla con marcada", durationMin: 40, bufferMin: 5, priceUnits: 17_000n, commissionBps: 5000 },
] as const;

const ADDRESS = "Calle 9Sur #53-71, Medellín";
const MAPS_URL = "https://www.google.com/maps/search/?api=1&query=Calle%209Sur%20%2353-71%2C%20Medell%C3%ADn";

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

// Nombres inventados: los del equipo real son datos personales (Ley 1581) y no van al repositorio.
// Diez perfiles con turnos escalonados: entre todos cubren de 8:00 a. m. a 9:00 p. m.
const BARBERS = [
  { name: "Andrés Gómez", schedule: week(h(9), h(13), h(19)) },
  { name: "Camilo Restrepo", schedule: week(h(10), h(14), h(20)) },
  { name: "Julián Ríos", schedule: week(h(9), h(12), h(18), true) },
  { name: "Mateo Cardona", schedule: week(h(11), h(15), h(20), true) },
  { name: "Santiago Vélez", schedule: week(h(8), h(12), h(17)) },
  { name: "Daniel Ospina", schedule: week(h(12), h(16), h(21)) },
  { name: "Felipe Arango", schedule: week(h(8), h(13), h(17)) },
  { name: "Esteban Muñoz", schedule: week(h(12), h(17), h(21), true) },
  { name: "Laura Henao", schedule: week(h(8), h(12), h(17)) },
  { name: "Sara Montoya", schedule: week(h(12), h(15), h(21)) },
] as const;

/**
 * Cuentas de prueba para ingresar como recepción (el "panel de caja") y como barbero. Correos en
 * .test (dominio reservado: nunca llega un correo real). La contraseña SIEMPRE es al azar y se
 * muestra una sola vez en la terminal de quien corre el seed: si por error (un túnel a producción
 * por localhost) las cuentas llegaran a otra base, nadie más conocería la clave, igual que una
 * cuenta que crea el dueño. Solo con base local: con ALLOW_SEED_DEMO=1 no se crean. Nunca la del
 * dueño: esa la crea el dueño con npm run staff:create-owner. Auditoría del sprint 6 (M-1).
 */
const DEMO_ACCOUNTS: readonly { email: string; name: string; role: Exclude<Role, "owner"> }[] = [
  { email: "recepcion@villa.test", name: "Recepción de prueba", role: "reception" },
  { email: "barbero@villa.test", name: "Barbero de prueba", role: "barber" },
];

/**
 * tsx no fija NODE_ENV: con el .env de producción, mirar solo NODE_ENV no protege. Se exige una base
 * local (localhost, 127.0.0.1, ::1) o la opción explícita ALLOW_SEED_DEMO=1. Nunca imprime la URL.
 */
/** true si la base es local; false si solo pasó por ALLOW_SEED_DEMO=1. */
function assertDevDatabase(): boolean {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed-demo es solo para desarrollo: no se ejecuta con NODE_ENV=production");
  }
  let host = "";
  try {
    host = new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    // Sin URL válida: no es una base local reconocible.
  }
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
  if (!local && process.env.ALLOW_SEED_DEMO !== "1") {
    throw new Error("seed-demo solo corre contra una base local. Si de verdad es una base de pruebas, usa ALLOW_SEED_DEMO=1.");
  }
  return local;
}

async function main() {
  const localDatabase = assertDevDatabase();
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

  const missing: (typeof DEMO_ACCOUNTS)[number][] = [];
  for (const a of DEMO_ACCOUNTS) {
    const [found] = await client.select({ id: user.id }).from(user).where(eq(user.email, a.email));
    if (found) console.log(`Cuenta de prueba ${a.email}: ya existe (su contraseña no cambia).`);
    else missing.push(a);
  }
  if (missing.length > 0 && !localDatabase) {
    console.log("Cuentas de prueba: no se crean fuera de una base local (ALLOW_SEED_DEMO=1).");
  } else if (missing.length > 0) {
    const password = randomBytes(12).toString("base64url");
    for (const a of missing) {
      const { staffId } = await createStaffUser(d, { locationId, name: a.name, email: a.email, password, role: a.role });
      // El barbero de prueba atiende como el primero de la lista, para que tenga citas en "Mi día".
      if (a.role === "barber") await setWeeklySchedule(d, { locationId, staffId, blocks: BARBERS[0].schedule });
      console.log(`Cuenta de prueba ${a.email} (${a.role === "reception" ? "recepción" : "barbero"}): creada.`);
    }
    console.log(`Contraseña de las cuentas nuevas (se muestra solo esta vez; guárdala): ${password}`);
  }

  const settings = await locationSettings(d, locationId);
  const { name: _name, ...rest } = settings;
  await updateLocationSettings(d, locationId, {
    ...rest,
    // La dirección y el mapa solo se llenan si están vacíos: el seed no pisa datos reales.
    address: rest.address ?? ADDRESS,
    mapsUrl: rest.mapsUrl ?? MAPS_URL,
    publicPhone: DEMO_PHONE,
    publicBookingEnabled: true,
  });
  console.log(`Sede: dirección, teléfono ${DEMO_PHONE} y reserva en línea abierta.`);

  await client.$client.end();
}

main().catch((err) => {
  console.error("No se pudieron cargar los datos de prueba:", describeError(err));
  process.exit(1);
});
