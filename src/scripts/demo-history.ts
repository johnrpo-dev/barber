// Historia de la demo: un mes de operación de Barbería Villa (citas, cobros, cajas, cierres) para
// presentarle el sistema al dueño con datos creíbles. Ver docs/demo.md.
//
// TODO pasa por las funciones reales de la app (createAppointment, checkout, openCashSession, …),
// con todas sus reglas y los triggers de la base: cada asiento cuadra al COMMIT, igual que en la
// operación real. Lo único que se corrige después son las HORAS que pone la base (`now()`): tras
// cada operación, las marcas de tiempo que acaba de escribir se corren a la hora simulada (con
// session_replication_role = replica, por eso exige superusuario). Al final, docs/demo.md corre la
// prueba de cordura del respaldo (deploy/backup/sanity.sql) sobre esta base.
//
// La operación diaria la hace la cuenta de prueba de recepción. Lo que solo puede hacer un dueño
// (compras a crédito, pagos a proveedores desde el banco, anticipos y gastos fijos) lo hace
// "Administración de prueba": rol de dueño, SIN contraseña (no puede ingresar) e inactiva. Así nada
// en la bitácora queda a nombre del dueño real. Liquidar comisiones, aprobar la anulación pendiente
// y revisar los turnos con diferencia quedan para hacerlos en vivo en la presentación.
//
// Se niega a correr si la base no es la de la demo: DEMO_DATABASE_URL (superusuario, localhost),
// sin respaldos registrados y sin ventas previas.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { addDays, datesBetween, isoWeekday, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits, type Money, money } from "@/domain/money";
import { createAppointment, changeStatus } from "@/db/appointments";
import { cashDeposit, closeBusinessDay, closeCashSession, ledgerCash, openCashSession, payTips, tipsOwed } from "@/db/cash";
import { listExpenseCategories, listPaymentMethods } from "@/db/checkout-settings";
import { db } from "@/db/client";
import { giveAdvance } from "@/db/commissions";
import { addExpense } from "@/db/expenses";
import { recordPurchase } from "@/db/inventory";
import { paySupplier } from "@/db/payables";
import { listProducts } from "@/db/products";
import { registerRecurringExpense, saveRecurringExpense } from "@/db/recurring-expenses";
import { checkout } from "@/db/sales";
import { backupRuns, clients, locations, sales, services, staffMembers, staffSchedules, user } from "@/db/schema";
import { staffServiceIds } from "@/db/staff";
import type { Db } from "@/db/types";
import { requestVoid } from "@/db/voids";
import { describeError } from "@/lib/log";

const TZ = "America/Bogota";
const DAYS = 30;
/** Base de la caja que queda cada noche; lo demás se consigna. */
const BASE = fromUnits(200_000n);

// --- azar reproducible (la misma semilla da la misma demo) ---
let seed = 20261112;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p: number) => rand() < p;
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
function weighted<T>(xs: readonly { item: T; weight: number }[]): T {
  const total = xs.reduce((s, x) => s + x.weight, 0);
  let r = rand() * total;
  for (const x of xs) if ((r -= x.weight) < 0) return x.item;
  return xs[xs.length - 1]!.item;
}

/** Lo más pedido en Villa (orden del catálogo de seed-demo): peso relativo de cada servicio. */
const POPULARITY: Record<string, number> = {
  "Corte de cabello hombre o niño": 34,
  "Corte de cabello y barba": 20,
  "Manicure tradicional dama": 5,
  "Corte de cabello y barba (tarjeta Gold)": 7,
  "Pedicure tradicional dama": 3,
  "Corte de cabello (tarjeta Gold)": 8,
  "Pigmento en barba": 3,
  "Cejas con cuchilla": 6,
  "Aplicación de tinte": 2,
  "Barba con vapor": 4,
  "Barba sencilla": 6,
  "Barba sencilla con marcada": 4,
};

const FIRST = ["Juan", "Carlos", "Andrés", "Jorge", "Luis", "Diego", "Sebastián", "Alejandro", "Miguel", "Kevin", "Brayan", "Cristian", "Óscar", "Ricardo", "Tomás", "Samuel", "Emiliano", "Jerónimo", "Valentina", "Daniela", "Natalia", "Catalina", "Paula", "Mariana"];
const LAST = ["García", "Rodríguez", "López", "Martínez", "Zapata", "Mejía", "Álvarez", "Correa", "Giraldo", "Castaño", "Ramírez", "Torres", "Echeverri", "Posada", "Bedoya", "Quintero", "Salazar", "Jaramillo"];

const EXPENSES = [
  { category: "Insumos", text: "Cuchillas y talco", min: 18, max: 42 },
  { category: "Aseo", text: "Productos de aseo para el local", min: 15, max: 38 },
  { category: "Otros", text: "Café, azúcar y aromática para clientes", min: 9, max: 22 },
  { category: "Mantenimiento", text: "Arreglo de la manguera del lavacabezas", min: 25, max: 60 },
];

const ADMIN_NAME = "Administración de prueba";

/**
 * Compras a crédito (cuentas por pagar), por día de la historia (0 = el primero). Proveedores
 * inventados. Con 30 días de historia quedan: una pagada del banco, una vencida con un abono de la
 * caja, una que vence mañana y una al día. `units`: unidades de cada producto (por nombre).
 */
const CREDIT_PURCHASES = [
  {
    day: 0,
    supplier: "Distribuidora Capilar Antioquia",
    termDays: 15,
    units: { "Cera para peinar": 8, "Pomada de brillo": 6, "Gel de fijación fuerte": 10, "Shampoo anticaída": 4, "Acondicionador hidratante": 4, "Tónico capilar": 3 },
    note: "Pedido inicial de productos capilares",
    payment: { day: 14, percent: 100, from: "bank" as const },
  },
  {
    day: 6,
    supplier: "Insumos Barber Pro",
    termDays: 15,
    units: { "Aceite para barba": 6, "Bálsamo para barba": 6, "Shampoo para barba": 6 },
    note: "Línea de barba",
    payment: { day: 20, percent: 40, from: "cash" as const },
  },
  {
    day: 16,
    supplier: "Distribuidora Capilar Antioquia",
    termDays: 15,
    units: { "Cera para peinar": 6, "Gel de fijación fuerte": 8, "Pomada de brillo": 4 },
    note: "Reposición de ceras y geles",
    payment: null,
  },
  {
    day: 25,
    supplier: "Cosméticos Laureles",
    termDays: 30,
    units: { "Shampoo anticaída": 4, "Acondicionador hidratante": 4, "Tónico capilar": 3 },
    note: "Línea de cuidado capilar",
    payment: null,
  },
] as const;

/**
 * Anticipos a barberos (cuentas por cobrar a trabajadores, 1365), por día de la historia y por
 * posición en el equipo. Se descuentan en la liquidación que el dueño hace en vivo.
 */
const ADVANCES = [
  { day: 11, barber: 0, units: 50_000n, reason: "Anticipo de quincena" },
  { day: 23, barber: 2, units: 80_000n, reason: "Anticipo pedido por el barbero para una diligencia" },
] as const;

/**
 * Gastos fijos (sprint 8). Los del mes anterior quedan pagados del banco; los de este mes, por
 * pagar: el dueño los ve en Inicio y en Gastos fijos. `swing`: cuánto varía el monto real (servicios).
 */
const RECURRING = [
  { name: "Arriendo del local", category: "Arriendo", units: 3_200_000n, dayOfMonth: 5, swing: 0 },
  { name: "Energía, agua y gas", category: "Servicios públicos", units: 480_000n, dayOfMonth: 20, swing: 60 },
  { name: "Internet y teléfono", category: "Servicios públicos", units: 135_000n, dayOfMonth: 10, swing: 0 },
] as const;

/** Costo de compra de un producto: 55 % del precio de venta, en miles de pesos cerrados. */
const unitCost = (price: Money): bigint => ((price.minor * 55n) / 100n / 100_000n) * 100_000n;

async function main() {
  const url = process.env.DEMO_DATABASE_URL;
  if (!url) throw new Error("Falta DEMO_DATABASE_URL (la base de la demo; ver docs/demo.md). Nunca uses la de la barbería.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) throw new Error("La historia de la demo solo se genera en una base local");
  process.env.DATABASE_URL = url;

  const client = db();
  const d = client as unknown as Db;
  const raw = client.$client;

  const [role] = await raw<{ sup: boolean }[]>`select rolsuper as sup from pg_roles where rolname = current_user`;
  if (!role?.sup) throw new Error("La base de la demo debe usarse con un superusuario (corrige las horas de la base); ver docs/demo.md");
  if ((await client.select({ id: backupRuns.id }).from(backupRuns).limit(1)).length > 0) {
    throw new Error("Esta base tiene respaldos registrados: parece producción. No se genera la demo aquí.");
  }
  const [location] = await client.select({ id: locations.id }).from(locations).where(eq(locations.name, "Barbería Villa"));
  if (!location) throw new Error("No existe la sede: corre primero db:seed y db:seed-demo");
  const locationId = location.id;
  if ((await client.select({ id: sales.id }).from(sales).where(eq(sales.locationId, locationId)).limit(1)).length > 0) {
    throw new Error("La sede ya tiene ventas: la demo se genera sobre una base recién sembrada (npm run demo:setup la rehace)");
  }

  // --- quién opera: la cuenta de prueba de recepción ---
  const [reception] = await client
    .select({ userId: user.id, staffId: staffMembers.id })
    .from(user)
    .innerJoin(staffMembers, eq(staffMembers.userId, user.id))
    .where(and(eq(user.email, "recepcion@villa.test"), eq(staffMembers.locationId, locationId)));
  if (!reception) throw new Error("Falta la cuenta recepcion@villa.test: corre npm run db:seed-demo en esta base");
  const actor = { userId: reception.userId, role: "reception" as const, staffId: reception.staffId };

  // --- lo que solo hace un dueño: una cuenta SIN contraseña (no hay fila en `account`: no puede
  // ingresar) e inactiva desde el principio (no cuenta como dueño de la sede ni sale en la agenda) ---
  const adminUserId = randomUUID();
  await client.insert(user).values({ id: adminUserId, name: ADMIN_NAME, email: "admin-demo@villa.test", emailVerified: true });
  const [adminStaff] = await client
    .insert(staffMembers)
    .values({ locationId, userId: adminUserId, displayName: ADMIN_NAME, role: "owner", active: false, bookableOnline: false })
    .returning({ id: staffMembers.id });
  const admin = { userId: adminUserId, role: "owner" as const, staffId: adminStaff!.id };

  // --- el equipo que sale en la vitrina (sin las cuentas de prueba) con su horario y servicios ---
  const team = await client
    .select({ id: staffMembers.id, name: staffMembers.displayName })
    .from(staffMembers)
    .where(and(eq(staffMembers.locationId, locationId), eq(staffMembers.role, "barber"), eq(staffMembers.active, true), eq(staffMembers.bookableOnline, true)));
  const catalog = await client.select({ id: services.id, name: services.name, durationMin: services.durationMin, bufferMin: services.bufferMin, price: services.price }).from(services).where(and(eq(services.locationId, locationId), eq(services.active, true)));
  const schedule = await client.select().from(staffSchedules).where(eq(staffSchedules.locationId, locationId));
  const barbers = await Promise.all(
    team.map(async (b) => {
      const offered = new Set(await staffServiceIds(d, { locationId, staffId: b.id }));
      return {
        ...b,
        services: catalog.filter((s) => offered.has(s.id)).map((s) => ({ item: s, weight: POPULARITY[s.name] ?? 1 })),
        blocks: schedule.filter((s) => s.staffId === b.id),
        offersAddOn: catalog.some((s) => s.name === "Cejas con cuchilla" && offered.has(s.id)),
      };
    }),
  );
  if (barbers.length === 0) throw new Error("No hay barberos: corre npm run db:seed-demo");
  const methods = await listPaymentMethods(d, { locationId, activeOnly: true });
  const method = (kind: string) => methods.find((m) => m.kind === kind);
  const cash = method("cash");
  if (!cash) throw new Error("Falta el medio de pago Efectivo");
  const categories = await listExpenseCategories(d, { locationId, activeOnly: true });
  const productList = await listProducts(d, { locationId, activeOnly: true });
  const productByName = new Map(productList.map((p) => [p.name, p]));
  const addOn = catalog.find((s) => s.name === "Cejas con cuchilla") ?? null;

  // --- clientes de la demo: nombres inventados, SIN celular ni correo (nunca se les manda nada) ---
  const names = new Set<string>();
  while (names.size < 140) names.add(`${pick(FIRST)} ${pick(LAST)}`);
  const clientRows = await client
    .insert(clients)
    .values([...names].map((name) => ({ locationId, name })))
    .returning({ id: clients.id });
  const regulars = clientRows.slice(0, 45).map((c) => c.id);
  const occasional = clientRows.slice(45).map((c) => c.id);
  const someClient = () => (chance(0.55) ? pick(regulars) : pick(occasional));

  // --- corrimiento de las horas que pone la base ---
  const tsColumns = await raw<{ t: string; c: string }[]>`
    select table_name as t, column_name as c from information_schema.columns
     where table_schema = 'public' and data_type = 'timestamp with time zone'`;
  const dbNow = async () => new Date((await raw<{ now: Date }[]>`select clock_timestamp() as now`)[0]!.now);
  /** Corre a `sim` todo lo que la base fechó desde `since` (conserva las diferencias entre filas). */
  async function shift(since: Date, sim: Date) {
    const deltaMs = since.getTime() - sim.getTime();
    if (deltaMs <= 0) return;
    const sinceLit = since.toISOString();
    const body = tsColumns.map(({ t, c }) => `UPDATE public."${t}" SET "${c}" = "${c}" - interval '${deltaMs} milliseconds' WHERE "${c}" >= '${sinceLit}';`).join("\n");
    await raw.begin(async (tx) => {
      await tx.unsafe("SET LOCAL session_replication_role = replica");
      await tx.unsafe(`DO $demo$ BEGIN\n${body}\nEND $demo$;`);
    });
  }
  /** Una operación "a la hora" `sim`: corre con now = sim y luego corre sus marcas de tiempo. */
  async function asOf<T>(sim: Date, fn: (now: Date) => Promise<T>): Promise<T> {
    const since = new Date((await dbNow()).getTime() - 1000);
    const out = await fn(sim);
    await shift(since, sim);
    return out;
  }

  let key = 0;
  const nextKey = (what: string) => `demo-${what}-${++key}`;
  const today = businessDate(new Date(), TZ);
  const firstDay = addDays(today, -DAYS);
  const realNow = new Date();
  const stats = { sales: 0, appointments: 0, noShows: 0, days: 0, recurring: 0, creditPurchases: 0, supplierPayments: 0, advances: 0 };

  /** Cobra con un medio al azar (efectivo la mitad de las veces); a veces mitad efectivo y mitad otro. */
  function payments(total: Money) {
    const kind = weighted([
      { item: "cash", weight: 50 },
      { item: "wallet", weight: 22 },
      { item: "card", weight: 18 },
      { item: "transfer", weight: 10 },
    ]);
    const m = method(kind) ?? cash!;
    if (kind !== "cash" && chance(0.06) && total.minor > 1_000_000n) {
      const part = fromUnits(10_000n);
      return [
        { methodId: cash!.id, amount: part },
        { methodId: m.id, amount: money(total.minor - part.minor) },
      ];
    }
    return [{ methodId: m.id, amount: total }];
  }

  /**
   * Cobro de un servicio a la hora `when`: a veces con cejas de más, uno o dos productos capilares
   * y propina. Así los recibos traen servicios y productos juntos, como en el mostrador.
   */
  async function charge(input: { when: Date; barberId: bigint; serviceId: bigint; price: bigint; appointmentId: bigint | null; clientId: bigint | null; offersAddOn: boolean }) {
    const picked = productList.length > 0 && chance(0.16) ? [pick(productList)] : [];
    if (picked.length > 0 && chance(0.2)) {
      const second = pick(productList);
      if (second.id !== picked[0]!.id) picked.push(second);
    }
    const withAddOn = addOn !== null && input.offersAddOn && addOn.id !== input.serviceId && chance(0.1);
    const tip = chance(0.28) ? fromUnits(BigInt(pick([2_000, 3_000, 5_000, 5_000, 10_000]))) : null;
    const due = input.price + picked.reduce((s, p) => s + p.price.minor, 0n) + (withAddOn ? addOn.price : 0n) + (tip?.minor ?? 0n);
    const extras = [
      ...(input.appointmentId === null ? [{ serviceId: input.serviceId, staffId: input.barberId }] : []),
      ...(withAddOn ? [{ serviceId: addOn.id, staffId: input.barberId }] : []),
    ];
    await asOf(input.when, (now) =>
      checkout(d, {
        locationId,
        appointmentId: input.appointmentId,
        clientId: input.appointmentId === null ? input.clientId : undefined,
        extras,
        products: picked.map((p) => ({ productId: p.id, quantity: 1, staffId: input.barberId })),
        discounts: [],
        tips: tip ? [{ staffId: input.barberId, amount: tip }] : [],
        payments: payments(money(due)),
        idempotencyKey: nextKey("sale"),
        actor,
        now,
      }),
    );
    stats.sales++;
  }

  /** Lo que hace un barbero en un día: turnos llenos a ratos, con citas y clientes que llegan sin cita. */
  function plan(date: string) {
    const weekday = isoWeekday(date);
    const events: { start: number; end: number; barber: (typeof barbers)[number]; service: (typeof catalog)[number]; walkIn: boolean }[] = [];
    const busyBoost = weekday === 5 || weekday === 6 ? 0.12 : 0; // viernes y sábado se llena más
    for (const barber of barbers) {
      if (barber.services.length === 0) continue;
      for (const block of barber.blocks.filter((b) => b.weekday === weekday)) {
        let t = block.startMin + between(0, 4) * 5;
        while (t < block.endMin) {
          const service = weighted(barber.services);
          const end = t + service.durationMin + service.bufferMin;
          if (end > block.endMin) break;
          if (chance(0.5 + busyBoost)) {
            events.push({ start: t, end, barber, service, walkIn: chance(0.38) });
            t = end + between(0, 3) * 5;
          } else {
            t += 30;
          }
        }
      }
    }
    return events.sort((a, b) => a.start - b.start);
  }

  async function cashToClose() {
    return ledgerCash(d, locationId);
  }

  // --- gastos fijos: las plantillas desde el mes en que empieza la historia ---
  const startMonth = `${firstDay.slice(0, 7)}-01`;
  const recurring = [];
  for (const r of RECURRING) {
    const category = categories.find((c) => c.name === r.category);
    if (!category) throw new Error(`Falta la categoría de gasto "${r.category}"`);
    const { id } = await asOf(localMinuteToInstant(firstDay, 7 * 60, TZ), (now) =>
      saveRecurringExpense(d, {
        locationId,
        categoryId: category.id,
        draft: { name: r.name, estimatedAmount: fromUnits(r.units), payMode: "bank", dayOfMonth: r.dayOfMonth, intervalMonths: 1, startMonth, active: true },
        actor: admin,
        now,
      }),
    );
    recurring.push({ ...r, id });
    // Lo del mes anterior que venció antes de que empiece la historia también quedó pago (el primer día).
    if (firstDay.slice(0, 7) < today.slice(0, 7) && r.dayOfMonth < Number(firstDay.slice(8, 10))) {
      await asOf(localMinuteToInstant(firstDay, 8 * 60, TZ), (now) =>
        registerRecurringExpense(d, { locationId, recurringId: id, period: startMonth, amount: fromUnits(r.units), description: r.name, expectedPayMode: "bank", actor: admin, now }),
      );
      stats.recurring++;
    }
  }

  const creditDocs = new Map<number, { documentId: bigint; total: Money }>();
  let leftToCharge = false;

  for (const [dayIndex, date] of datesBetween(firstDay, today).entries()) {
    const isToday = date === today;
    const at = (minute: number) => localMinuteToInstant(date, minute, TZ);
    const events = plan(date);

    // Gastos fijos del mes anterior: se pagan del banco el día que vencen. Los de este mes quedan por pagar.
    if (date.slice(0, 7) < today.slice(0, 7)) {
      for (const r of recurring.filter((x) => x.dayOfMonth === Number(date.slice(8, 10)))) {
        const real = r.swing === 0 ? r.units : r.units + BigInt(between(-r.swing, r.swing) * 1000);
        await asOf(at(9 * 60), (now) =>
          registerRecurringExpense(d, {
            locationId,
            recurringId: r.id,
            period: `${date.slice(0, 7)}-01`,
            amount: fromUnits(real),
            description: r.name,
            expectedPayMode: "bank",
            actor: admin,
            now,
          }),
        );
        stats.recurring++;
      }
    }

    // Compras a crédito: llegan en la mañana, antes de abrir (la primera surte el inventario inicial).
    for (const [i, p] of CREDIT_PURCHASES.entries()) {
      if (p.day !== dayIndex) continue;
      const lines = Object.entries(p.units).map(([name, quantity]) => {
        const product = productByName.get(name);
        if (!product) throw new Error(`Falta el producto "${name}": corre npm run db:seed-demo en esta base`);
        return { productId: product.id, quantity, amount: money(unitCost(product.price) * BigInt(quantity)) };
      });
      const doc = await asOf(at(7 * 60 + 30), (now) =>
        recordPurchase(d, { locationId, paidFrom: "credit", credit: { supplierName: p.supplier, termDays: p.termDays }, lines, note: p.note, idempotencyKey: nextKey("credit"), actor: admin, now }),
      );
      creditDocs.set(i, doc);
      stats.creditPurchases++;
    }

    if (events.length === 0) continue;
    stats.days++;

    // Apertura: se cuenta lo que dejó el cierre anterior.
    const opening = money(await cashToClose());
    await asOf(at(events[0]!.start - 10), (now) => openCashSession(d, { locationId, counted: opening, idempotencyKey: nextKey("open"), actor, now }));

    let lastMinute = events[0]!.start;
    for (const e of events) {
      const startAt = at(e.start);
      const endAt = at(e.end - e.service.bufferMin);
      if (isToday && startAt > realNow) continue; // lo de más tarde hoy se agenda al final, con la hora real
      const clientId = someClient();
      if (e.walkIn) {
        if (isToday && endAt > realNow) continue;
        await charge({ when: new Date(endAt.getTime() + 2 * 60_000), barberId: e.barber.id, serviceId: e.service.id, price: e.service.price, appointmentId: null, clientId: chance(0.4) ? clientId : null, offersAddOn: e.barber.offersAddOn });
      } else {
        const bookedAt = new Date(startAt.getTime() - between(2, 96) * 3_600_000);
        let appt: { appointmentId: bigint };
        try {
          appt = await asOf(bookedAt, (now) =>
            createAppointment(d, { locationId, serviceId: e.service.id, staffId: e.barber.id, start: startAt, clientId, source: "staff", idempotencyKey: nextKey("appt"), createdBy: actor.userId, now }),
          );
        } catch {
          continue; // el hueco ya estaba ocupado o fuera del turno: ese cliente no vino
        }
        stats.appointments++;
        if (chance(0.05)) {
          await asOf(new Date(startAt.getTime() + 25 * 60_000), (now) =>
            changeStatus(d, { locationId, appointmentId: appt.appointmentId, to: "no_show", actor, now }),
          ).catch(() => undefined);
          stats.noShows++;
          continue;
        }
        await asOf(new Date(startAt.getTime() - 4 * 60_000), (now) => changeStatus(d, { locationId, appointmentId: appt.appointmentId, to: "arrived", actor, now }));
        await asOf(startAt, (now) => changeStatus(d, { locationId, appointmentId: appt.appointmentId, to: "in_chair", actor, now }));
        if (isToday && endAt > realNow) continue; // está en la silla ahora mismo
        await asOf(endAt, (now) => changeStatus(d, { locationId, appointmentId: appt.appointmentId, to: "completed", actor, now }));
        // Hoy, una cita que terminó hace poco queda atendida y sin cobrar: sale en "Por cobrar" de Caja.
        if (isToday && !leftToCharge && endAt.getTime() > realNow.getTime() - 50 * 60_000) {
          leftToCharge = true;
          continue;
        }
        await charge({ when: new Date(endAt.getTime() + 2 * 60_000), barberId: e.barber.id, serviceId: e.service.id, price: e.service.price, appointmentId: appt.appointmentId, clientId, offersAddOn: e.barber.offersAddOn });
      }
      lastMinute = Math.max(lastMinute, e.end);

      // A media tarde, a veces, un gasto de la caja.
      if (e.start >= 14 * 60 && e.start < 14 * 60 + 15 && chance(0.35)) {
        const x = pick(EXPENSES);
        const category = categories.find((c) => c.name === x.category) ?? categories[0];
        if (category && (await cashToClose()) > fromUnits(BigInt(x.max * 1000)).minor) {
          await asOf(at(e.start + 5), (now) =>
            addExpense(d, { locationId, categoryId: category.id, amount: fromUnits(BigInt(between(x.min, x.max) * 1000)), paidFrom: "cash", description: x.text, idempotencyKey: nextKey("expense"), actor, now }),
          );
        }
      }
    }

    // El tercer día, recepción compra de contado, con plata de la caja, lo que se acabó primero.
    if (dayIndex === 3) {
      const lines = ["Gel de fijación fuerte", "Shampoo para barba"].flatMap((name) => {
        const product = productByName.get(name);
        return product ? [{ productId: product.id, quantity: 4, amount: money(unitCost(product.price) * 4n) }] : [];
      });
      const total = lines.reduce((s, l) => s + l.amount.minor, 0n);
      if (lines.length > 0 && (await cashToClose()) - BASE.minor > total) {
        await asOf(at(lastMinute + 5), (now) => recordPurchase(d, { locationId, paidFrom: "cash", lines, note: "Compra de contado en el almacén", idempotencyKey: nextKey("purchase"), actor, now }));
      }
    }

    // Abonos a proveedores: de la caja los hace recepción (si alcanza el efectivo); del banco, el dueño.
    for (const [i, p] of CREDIT_PURCHASES.entries()) {
      if (!p.payment || p.payment.day !== dayIndex) continue;
      const doc = creditDocs.get(i);
      if (!doc) continue;
      const amount = (((doc.total.minor * BigInt(p.payment.percent)) / 100n) / 100_000n) * 100_000n;
      const fromCash = p.payment.from === "cash" && (await cashToClose()) - BASE.minor > amount;
      await asOf(at(lastMinute + 7), (now) =>
        paySupplier(d, {
          locationId,
          documentId: doc.documentId,
          amount: money(p.payment.percent === 100 ? doc.total.minor : amount),
          paidFrom: fromCash ? "cash" : "bank",
          idempotencyKey: nextKey("supplier-pay"),
          actor: fromCash ? actor : admin,
          now,
        }),
      );
      stats.supplierPayments++;
    }

    // Anticipos a barberos (por cobrar): de la caja si alcanza; si no, del banco.
    for (const a of ADVANCES) {
      const barber = barbers[a.barber % barbers.length];
      if (a.day !== dayIndex || !barber) continue;
      const amount = fromUnits(a.units);
      const fromCash = (await cashToClose()) - BASE.minor > amount.minor;
      await asOf(at(lastMinute + 9), (now) =>
        giveAdvance(d, { locationId, staffId: barber.id, amount, paidFrom: fromCash ? "cash" : "bank", reason: a.reason, idempotencyKey: nextKey("advance"), actor: admin, now }),
      );
      stats.advances++;
    }

    // Hoy se queda abierto: la caja está en turno durante la presentación. Una venta repetida queda
    // con la anulación pedida, para que el dueño la apruebe en vivo.
    if (isToday) {
      const last = await client
        .select({ id: sales.id })
        .from(sales)
        .where(and(eq(sales.locationId, locationId), eq(sales.businessDate, date)))
        .orderBy(sql`${sales.id} desc`)
        .limit(1);
      if (last[0]) {
        await asOf(new Date(Math.min(realNow.getTime(), at(lastMinute + 3).getTime())), () =>
          requestVoid(d, { locationId, saleId: last[0]!.id, reason: "Se cobró dos veces el mismo corte", idempotencyKey: nextKey("void"), actor }),
        );
      }
      break;
    }

    // Cierre: propinas en efectivo, consignación de lo que pase de la base, arqueo y cierre del día.
    const closeAt = (offset: number) => at(Math.max(lastMinute, 20 * 60) + offset);
    for (const owed of await tipsOwed(d, locationId)) {
      if (owed.owed > 0n && owed.owed <= (await cashToClose())) {
        await asOf(closeAt(10), (now) => payTips(d, { locationId, staffId: owed.staffId, amount: money(owed.owed), idempotencyKey: nextKey("tips"), actor, now }));
      }
    }
    const extra = (await cashToClose()) - BASE.minor;
    if (extra > 0n) {
      await asOf(closeAt(15), (now) => cashDeposit(d, { locationId, amount: money(extra), idempotencyKey: nextKey("deposit"), actor, now }));
    }
    const expected = await cashToClose();
    // Tres cierres con diferencia (dos faltantes y un sobrante): el dueño los ve por revisar en Inicio.
    const daysAgo = DAYS - datesBetween(firstDay, date).length + 1;
    const diff = daysAgo === 19 ? -2_000n : daysAgo === 6 ? 1_000n : daysAgo === 2 ? -5_000n : 0n;
    const note = diff < 0n ? "Faltó plata en monedas; se revisa con el turno" : diff > 0n ? "Sobró: un cliente no esperó las vueltas" : undefined;
    await asOf(closeAt(20), (now) =>
      closeCashSession(d, { locationId, counted: money(expected + diff * 100n), note, idempotencyKey: nextKey("close"), actor, now }),
    );
    await asOf(closeAt(25), (now) => closeBusinessDay(d, { locationId, businessDate: date, actor, now }));
  }

  // Lo que sigue de hoy y mañana: citas agendadas con la hora real (no hay nada que correr).
  let booked = 0;
  for (const date of [today, addDays(today, 1)]) {
    for (const e of plan(date)) {
      const startAt = localMinuteToInstant(date, e.start, TZ);
      if (startAt <= new Date(Date.now() + 10 * 60_000) || e.walkIn) continue;
      try {
        await createAppointment(d, { locationId, serviceId: e.service.id, staffId: e.barber.id, start: startAt, clientId: someClient(), source: "staff", idempotencyKey: nextKey("appt"), createdBy: actor.userId });
        booked++;
      } catch {
        // hueco ocupado: se omite
      }
    }
  }

  console.log(
    `Demo lista: ${stats.days} días (${firstDay} a ${today}), ${stats.sales} cobros, ${stats.appointments} citas (${stats.noShows} no vinieron) y ${booked} citas agendadas para hoy y mañana.`,
  );
  console.log(
    `Por pagar y por cobrar: ${stats.creditPurchases} compras a crédito, ${stats.supplierPayments} abonos a proveedores, ${stats.advances} anticipos a barberos y ${stats.recurring} pagos de gastos fijos del mes anterior (los de este mes quedan por pagar).`,
  );
  await raw.end();
}

main().catch((err) => {
  console.error("No se pudo generar la historia de la demo:", describeError(err));
  process.exit(1);
});
