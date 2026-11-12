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
// Todo lo hace la cuenta de prueba de recepción: nada queda a nombre del dueño. Lo que solo puede
// hacer el dueño (liquidar comisiones, aprobar la anulación pendiente, revisar los turnos con
// diferencia, compras a crédito, gastos fijos) queda para hacerlo en vivo en la presentación.
//
// Se niega a correr si la base no es la de la demo: DEMO_DATABASE_URL (superusuario, localhost),
// sin respaldos registrados y sin ventas previas.
import { and, eq, sql } from "drizzle-orm";
import { addDays, datesBetween, isoWeekday, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits, type Money, money } from "@/domain/money";
import { createAppointment, changeStatus } from "@/db/appointments";
import { cashDeposit, closeBusinessDay, closeCashSession, ledgerCash, openCashSession, payTips, tipsOwed } from "@/db/cash";
import { listExpenseCategories, listPaymentMethods } from "@/db/checkout-settings";
import { db } from "@/db/client";
import { addExpense } from "@/db/expenses";
import { recordPurchase } from "@/db/inventory";
import { listProducts } from "@/db/products";
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
  const stats = { sales: 0, appointments: 0, noShows: 0, days: 0 };

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

  /** Cobro de un servicio (con propina y, a veces, un producto) a la hora `when`. */
  async function charge(input: { when: Date; barberId: bigint; serviceId: bigint; price: bigint; appointmentId: bigint | null; clientId: bigint | null }) {
    const product = productList.length > 0 && chance(0.09) ? pick(productList) : null;
    const tip = chance(0.28) ? fromUnits(BigInt(pick([2_000, 3_000, 5_000, 5_000, 10_000]))) : null;
    const due = input.price + (product?.price.minor ?? 0n) + (tip?.minor ?? 0n);
    await asOf(input.when, (now) =>
      checkout(d, {
        locationId,
        appointmentId: input.appointmentId,
        clientId: input.appointmentId === null ? input.clientId : undefined,
        extras: input.appointmentId === null ? [{ serviceId: input.serviceId, staffId: input.barberId }] : [],
        products: product ? [{ productId: product.id, quantity: 1, staffId: input.barberId }] : [],
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

  for (const date of datesBetween(firstDay, today)) {
    const isToday = date === today;
    const at = (minute: number) => localMinuteToInstant(date, minute, TZ);
    const events = plan(date);
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
        await charge({ when: new Date(endAt.getTime() + 2 * 60_000), barberId: e.barber.id, serviceId: e.service.id, price: e.service.price, appointmentId: null, clientId: chance(0.4) ? clientId : null });
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
        await charge({ when: new Date(endAt.getTime() + 2 * 60_000), barberId: e.barber.id, serviceId: e.service.id, price: e.service.price, appointmentId: appt.appointmentId, clientId });
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

    // El tercer día, recepción compra mercancía de la caja (para que haya inventario y margen).
    if (date === addDays(firstDay, 3) && productList.length > 0) {
      const lines = productList.map((p) => ({ productId: p.id, quantity: 4, amount: money(((p.price.minor * 55n) / 100n / 100_000n) * 100_000n * 4n) }));
      const total = lines.reduce((s, l) => s + l.amount.minor, 0n);
      if ((await cashToClose()) - BASE.minor > total) {
        await asOf(at(lastMinute + 5), (now) => recordPurchase(d, { locationId, paidFrom: "cash", lines, note: "Pedido de la distribuidora", idempotencyKey: nextKey("purchase"), actor, now }));
      }
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
  await raw.end();
}

main().catch((err) => {
  console.error("No se pudo generar la historia de la demo:", describeError(err));
  process.exit(1);
});
