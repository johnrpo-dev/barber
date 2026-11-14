// Datos de prueba para recorrer la app en local: servicios, barberos con horario (inventados o, si
// existe seed-demo.equipo.local.json, los del equipo real), teléfono de
// la sede, reserva en línea abierta y dos cuentas de prueba (recepción y barbero) para ver el panel
// como cada rol. Se puede ejecutar varias veces: no duplica (busca por nombre).
// No toca el libro contable. Se niega a correr en producción.
// Uso: npm run db:seed-demo
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Role } from "@/domain/staff/roles";
import { fromUnits } from "@/domain/money";
import type { ScheduleBlock, Weekday } from "@/domain/staff/schedule";
import { describeError } from "@/lib/log";
import { createService } from "./catalog";
import { db } from "./client";
import { locationSettings, setStaffBookableOnline, updateLocationSettings } from "./locations";
import { createProduct } from "./products";
import { backupRuns, locations, products, services, staffMembers, user } from "./schema";
import { seedDemoHostMode, seedDemoMode } from "./seed-demo-guard";
import { addStaffMember, createStaffUser, setStaffActive, setStaffServices, setWeeklySchedule, staffServiceIds } from "./staff";
import type { Db } from "./types";

const LOCATION_NAME = "Barbería Villa";
const DEMO_PHONE = "+573003024035"; // Solo para pruebas.

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

/**
 * Productos capilares de ejemplo: sin compras ni existencias (esas las registra el dueño o, en la
 * demo, src/scripts/demo-history.ts). Precios de venta al público inventados, en pesos.
 */
const PRODUCTS = [
  { name: "Cera para peinar", priceUnits: 35_000n },
  { name: "Aceite para barba", priceUnits: 40_000n },
  { name: "Shampoo para barba", priceUnits: 30_000n },
  { name: "Bálsamo para barba", priceUnits: 38_000n },
  { name: "Pomada de brillo", priceUnits: 32_000n },
  { name: "Gel de fijación fuerte", priceUnits: 18_000n },
  { name: "Shampoo anticaída", priceUnits: 38_000n },
  { name: "Acondicionador hidratante", priceUnits: 34_000n },
  { name: "Tónico capilar", priceUnits: 42_000n },
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

// Diez turnos escalonados (inventados): entre todos cubren de 8:00 a. m. a 9:00 p. m.
const SCHEDULES = [
  week(h(9), h(13), h(19)),
  week(h(10), h(14), h(20)),
  week(h(9), h(12), h(18), true),
  week(h(11), h(15), h(20), true),
  week(h(8), h(12), h(17)),
  week(h(12), h(16), h(21)),
  week(h(8), h(13), h(17)),
  week(h(12), h(17), h(21), true),
  week(h(8), h(12), h(17)),
  week(h(12), h(15), h(21)),
] as const;

// Nombres inventados: los del equipo real son datos personales (Ley 1581) y no van al repositorio.
const INVENTED_NAMES = [
  "Andrés Gómez",
  "Camilo Restrepo",
  "Julián Ríos",
  "Mateo Cardona",
  "Santiago Vélez",
  "Daniel Ospina",
  "Felipe Arango",
  "Esteban Muñoz",
  "Laura Henao",
  "Sara Montoya",
] as const;

/**
 * Equipo real, opcional: `seed-demo.equipo.local.json` en la raíz (git lo ignora). Cada persona es
 * un nombre, o un objeto con lo que hace: `{ "name": "Valentina", "services": ["Manicure tradicional
 * dama"] }` (solo esos) o `{ "name": "Danilso", "skip": ["Manicure tradicional dama"] }` (todos
 * menos esos). Si existe, el seed crea esas personas y, en una base local, desactiva las inventadas
 * (no las borra: su historial queda). Si no, usa las inventadas, que hacen todo.
 */
const TEAM_FILE = "seed-demo.equipo.local.json";

interface TeamMember {
  name: string;
  /** Solo estos servicios (por nombre). */
  services?: string[];
  /** Todos menos estos. */
  skip?: string[];
}

const nameList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim().length > 0);

function realTeam(): TeamMember[] | null {
  const path = resolve(process.cwd(), TEAM_FILE);
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const bad = () => new Error(`${TEAM_FILE} debe ser una lista de nombres u objetos { "name", "services" | "skip" }`);
  if (!Array.isArray(parsed) || parsed.length === 0) throw bad();
  const members = parsed.map((m): TeamMember => {
    if (typeof m === "string") return { name: m.trim() };
    if (typeof m !== "object" || m === null) throw bad();
    const o = m as Record<string, unknown>;
    if (typeof o.name !== "string") throw bad();
    if (o.services !== undefined && !nameList(o.services)) throw bad();
    if (o.skip !== undefined && !nameList(o.skip)) throw bad();
    if (o.services !== undefined && o.skip !== undefined) throw new Error(`${TEAM_FILE}: "${o.name}" usa "services" o "skip", no los dos`);
    return { name: o.name.trim(), services: o.services as string[] | undefined, skip: o.skip as string[] | undefined };
  });
  if (members.some((m) => m.name.length === 0 || m.name.length > 80)) throw bad();
  if (new Set(members.map((m) => m.name.toLowerCase())).size !== members.length) throw new Error(`${TEAM_FILE} tiene nombres repetidos`);
  return members;
}

const team = realTeam();
const BARBERS = (team ?? INVENTED_NAMES.map((name) => ({ name }) as TeamMember)).map((m, i) => ({ ...m, schedule: SCHEDULES[i % SCHEDULES.length]! }));

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

async function main() {
  // tsx no fija NODE_ENV: con el .env de producción, mirar solo NODE_ENV no protege. Host local o
  // ALLOW_SEED_DEMO=1, y además la base no puede tener respaldos registrados (src/db/seed-demo-guard.ts).
  const hostMode = seedDemoHostMode(process.env);
  const client = db();
  const d = client as unknown as Db;
  const anyBackup = await client.select({ id: backupRuns.id }).from(backupRuns).limit(1);
  const localDatabase = seedDemoMode(hostMode, { hasBackups: anyBackup.length > 0 }, { ALLOW_SEED_DEMO: process.env.ALLOW_SEED_DEMO }) === "local";

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

  for (const p of PRODUCTS) {
    const [found] = await client
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.locationId, locationId), sql`lower(${products.name}) = lower(${p.name})`));
    if (found) {
      console.log(`Producto "${p.name}": ya existe.`);
      continue;
    }
    await createProduct(d, { locationId, draft: { name: p.name, sku: null, price: fromUnits(p.priceUnits), commissionBps: 0 } });
    console.log(`Producto "${p.name}": creado.`);
  }

  const catalog = await client.select({ id: services.id, name: services.name }).from(services).where(eq(services.locationId, locationId));
  const serviceId = (name: string) => {
    const found = catalog.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    if (!found) throw new Error(`${TEAM_FILE}: no existe el servicio "${name}"`);
    return found.id;
  };
  /** Lo que hace según el archivo, o null si hace todo. */
  const servicesFor = (b: TeamMember): bigint[] | null => {
    if (b.services) return b.services.map(serviceId);
    if (b.skip) {
      const skip = new Set(b.skip.map(serviceId));
      return catalog.filter((c) => !skip.has(c.id)).map((c) => c.id);
    }
    return null;
  };

  for (const b of BARBERS) {
    const wanted = servicesFor(b);
    const [found] = await client
      .select({ id: staffMembers.id })
      .from(staffMembers)
      .where(and(eq(staffMembers.locationId, locationId), eq(staffMembers.displayName, b.name)));
    if (found) {
      // Quien ya existe conserva su horario. Sus servicios solo se acotan si siguen como al crearla
      // (todos): si alguien ya los cambió en Personal, el seed no los pisa.
      const current = await staffServiceIds(d, { locationId, staffId: found.id });
      if (wanted && current.length === catalog.length) {
        await setStaffServices(d, { locationId, staffId: found.id, serviceIds: wanted });
        console.log(`Profesional "${b.name}": ya existe; sus servicios quedan como dice ${TEAM_FILE}.`);
      } else {
        console.log(`Profesional "${b.name}": ya existe; su horario y sus servicios no se tocan.`);
      }
      continue;
    }
    const staffId = await addStaffMember(d, { locationId, displayName: b.name, role: "barber" });
    await setWeeklySchedule(d, { locationId, staffId, blocks: b.schedule });
    if (wanted) await setStaffServices(d, { locationId, staffId, serviceIds: wanted });
    console.log(`Profesional "${b.name}": creado con su horario${wanted ? " y sus servicios" : ""}.`);
  }

  // Con el equipo real, los inventados dejan de atender (solo en base local; se desactivan, no se borran).
  if (team && localDatabase) {
    const keep = new Set(team.map((m) => m.name.toLowerCase()));
    for (const name of INVENTED_NAMES) {
      if (keep.has(name.toLowerCase())) continue;
      const [found] = await client
        .select({ id: staffMembers.id, active: staffMembers.active })
        .from(staffMembers)
        .where(and(eq(staffMembers.locationId, locationId), eq(staffMembers.displayName, name), eq(staffMembers.role, "barber"), isNull(staffMembers.userId)));
      if (!found?.active) continue;
      await setStaffActive(d, { locationId, staffId: found.id, active: false });
      console.log(`Barbero inventado "${name}": desactivado.`);
    }
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
      if (a.role === "barber") await setWeeklySchedule(d, { locationId, staffId, blocks: SCHEDULES[0] });
      console.log(`Cuenta de prueba ${a.email} (${a.role === "reception" ? "recepción" : "barbero"}): creada.`);
    }
    console.log(`Contraseña de las cuentas nuevas (se muestra solo esta vez; guárdala): ${password}`);
  }

  // Las cuentas de prueba no salen en la reserva en línea ni en la portada (es la vitrina del negocio);
  // al barbero de prueba se le agenda desde el panel.
  const demoStaff = await client
    .select({ id: staffMembers.id, bookable: staffMembers.bookableOnline })
    .from(staffMembers)
    .innerJoin(user, eq(user.id, staffMembers.userId))
    .where(and(eq(staffMembers.locationId, locationId), inArray(user.email, DEMO_ACCOUNTS.map((a) => a.email))));
  for (const m of demoStaff.filter((x) => x.bookable)) {
    await setStaffBookableOnline(d, { locationId, staffId: m.id, bookable: false });
    console.log("Cuenta de prueba: fuera de la reserva en línea.");
  }

  const settings = await locationSettings(d, locationId);
  const { name: _name, ...rest } = settings;
  await updateLocationSettings(d, locationId, {
    ...rest,
    // Dirección, mapa y teléfono solo se llenan si están vacíos: el seed no pisa datos reales. La
    // reserva en línea solo se abre sola en una base local (auditoría, LOW-1).
    address: rest.address ?? ADDRESS,
    mapsUrl: rest.mapsUrl ?? MAPS_URL,
    publicPhone: rest.publicPhone ?? DEMO_PHONE,
    publicBookingEnabled: localDatabase ? true : rest.publicBookingEnabled,
  });
  console.log(`Sede: dirección y teléfono (si faltaban)${localDatabase ? " y reserva en línea abierta" : ""}.`);

  await client.$client.end();
}

main().catch((err) => {
  console.error("No se pudieron cargar los datos de prueba:", describeError(err));
  process.exit(1);
});
