import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { changeStatus, createAppointment } from "@/db/appointments";
import { closeBusinessDay, closeCashSession, ledgerCash, openCashSession, openSession as openCash } from "@/db/cash";
import { checkout } from "@/db/sales";
import { requestVoid } from "@/db/voids";
import { createService } from "@/db/catalog";
import { findOrCreateClient } from "@/db/clients";
import { createLocation } from "@/db/ledger";
import { expenseCategories, paymentMethods, services, session, staffMembers, user } from "@/db/schema";
import { addStaffMember, createStaffUser, setWeeklySchedule } from "@/db/staff";
import { createTestDb } from "@/db/testing";
import { addTimeOff } from "@/db/time-off";
import type { Db } from "@/db/types";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { format, fromUnits, money } from "@/domain/money";
import type { PaymentKind } from "@/domain/sales/checkout";
import type { Role } from "@/domain/staff/roles";

// Pruebas de autorización: cada rol contra cada server action del panel, más el aislamiento
// entre sedes. Corre el `requireStaff`/`requirePermission` REAL sobre un PostgreSQL en memoria;
// solo se simulan la cookie de sesión (better-auth) y el redirect de Next.js.
// Si alguien amplía un permiso sin querer, o una acción olvida verificarlo, esto falla.

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  session: null as null | { user: { id: string; name: string; email: string }; session: { id: string } },
  /** El único código TOTP que acepta el verifyTOTP simulado (el real se prueba en src/lib/auth.test.ts). */
  totpCode: "246810",
  /** El único código de respaldo que acepta el verifyBackupCode simulado. */
  backupCode: "abcde-12345",
  /** Llamadas a los endpoints simulados que cambian el TOTP o cierran sesión (para ver que no se llegó). */
  apiCalls: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    // Igual que Next: un error con digest NEXT_REDIRECT que runAction debe dejar pasar.
    throw Object.assign(new Error(`redirect ${url}`), { url, digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // Fuera de una petición de Next no hay caché por petición: cada llamada consulta de nuevo.
  cache: <T>(fn: T) => fn,
}));
vi.mock("@/db/client", () => ({ db: () => state.db }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  auth: async () => ({
    api: {
      getSession: async () => state.session,
      verifyTOTP: async ({ body }: { body: { code: string } }) => {
        if (body.code !== state.totpCode) throw new Error("INVALID_CODE");
        return {};
      },
      verifyBackupCode: async ({ body }: { body: { code: string } }) => {
        if (body.code !== state.backupCode) throw new Error("INVALID_BACKUP_CODE");
        return {};
      },
      generateBackupCodes: async () => {
        state.apiCalls.push("generateBackupCodes");
        return { status: true, backupCodes: ["nuevo-00001", "nuevo-00002"] };
      },
      disableTwoFactor: async () => {
        state.apiCalls.push("disableTwoFactor");
        return { status: true };
      },
      signOut: async () => {
        state.apiCalls.push("signOut");
        return { success: true };
      },
    },
  }),
}));

const agenda = await import("./agenda/actions");
const servicios = await import("./servicios/actions");
const personal = await import("./personal/actions");
const bloqueos = await import("./bloqueos/actions");
const ajustes = await import("./ajustes/actions");
const cuenta = await import("../cuenta/actions");
const cobro = await import("./cobro/actions");
const caja = await import("./caja/actions");
const anulaciones = await import("./anulaciones/actions");
const panelRoot = await import("./actions");

const TZ = "America/Bogota";
const PASSWORD = "clave-de-prueba-123"; // valor de prueba, solo existe en esta base en memoria
const TEMP_PASSWORD = "clave-temporal-456";

type Person = { id: string; staffId: bigint; sessionId: string };
let db: Db;
let client: PGlite;
const A = {} as {
  location: bigint;
  users: Record<Role, Person>;
  otherBarber: bigint;
  dummy: bigint;
  service: bigint;
  client: bigint;
  methods: Record<PaymentKind, bigint>;
  category: bigint;
};
const B = {} as { location: bigint; owner: Person; service: bigint; barber: bigint };

async function methodsOf(locationId: bigint): Promise<Record<PaymentKind, bigint>> {
  const rows = await db.select({ id: paymentMethods.id, kind: paymentMethods.kind }).from(paymentMethods).where(eq(paymentMethods.locationId, locationId));
  return Object.fromEntries(rows.map((m) => [m.kind, m.id])) as Record<PaymentKind, bigint>;
}

let base: string;
let slot = 0;
/** Un horario libre distinto en cada llamada (45 min cubren corte de 30 + limpieza de 10). */
function nextSlot() {
  const k = slot++;
  return { date: addDays(base, Math.floor(k / 12)), minute: 9 * 60 + (k % 12) * 45 };
}

let seq = 0;
const uniq = () => `${++seq}`.padStart(8, "0");

async function appointmentFor(staffId: bigint): Promise<bigint> {
  const { date, minute } = nextSlot();
  const created = await createAppointment(db, {
    locationId: A.location,
    serviceId: A.service,
    staffId,
    start: localMinuteToInstant(date, minute, TZ),
    clientId: A.client,
    source: "staff",
    idempotencyKey: `seed-${uniq()}`,
    createdBy: "seed",
  });
  return created.appointmentId;
}

async function timeOffFor(staffId: bigint, offsetDays: number): Promise<bigint> {
  const date = addDays(base, offsetDays);
  const { id } = await addTimeOff(db, { locationId: A.location, staffId, kind: "block", createdBy: "seed", allDay: true, fromDate: date, toDate: date });
  return id;
}

// ─── Cobro y caja: estado de partida para cada intento ──────────────────────

const SEED_ACTOR = () => ({ userId: "seed", role: "owner" as const, staffId: A.users.owner.staffId });

/** Una cita de la sede A en silla, lista para cobrar. */
async function chairAppointment(): Promise<bigint> {
  const id = await appointmentFor(A.users.barber.staffId);
  await changeStatus(db, { locationId: A.location, appointmentId: id, to: "in_chair", actor: SEED_ACTOR() });
  return id;
}

/** El precio vigente del corte (otros casos lo editan): en centavos. */
async function servicePrice(): Promise<bigint> {
  const [row] = await db.select({ price: services.price }).from(services).where(eq(services.id, A.service));
  return row!.price;
}

/** Cobra una cita nueva de la sede A (por defecto con tarjeta). */
async function seedSale(opts: { kind?: PaymentKind; tip?: bigint } = {}): Promise<bigint> {
  const appointmentId = await chairAppointment();
  const tip = opts.tip ?? 0n;
  const { saleId } = await checkout(db, {
    locationId: A.location,
    appointmentId,
    extras: [],
    discounts: [],
    tips: tip > 0n ? [{ staffId: A.users.barber.staffId, amount: fromUnits(tip) }] : [],
    payments: [{ methodId: A.methods[opts.kind ?? "card"], amount: money((await servicePrice()) + fromUnits(tip).minor) }],
    idempotencyKey: `seed-sale-${uniq()}`,
    actor: SEED_ACTOR(),
  });
  return saleId;
}

/** Deja la caja de la sede A abierta o cerrada, contando exactamente lo esperado (sin diferencias). */
async function cashDrawer(open: boolean): Promise<void> {
  const current = await openCash(db, A.location);
  if (Boolean(current) === open) return;
  const counted = money(await ledgerCash(db, A.location));
  const input = { locationId: A.location, counted, idempotencyKey: `seed-cash-${uniq()}`, actor: { userId: "seed" } };
  if (open) await openCashSession(db, input);
  else await closeCashSession(db, input);
}

/** Un cierre de la sede A con un sobrante de $50.000 (más que el umbral): queda marcado para revisión. */
async function flaggedSession(): Promise<bigint> {
  await cashDrawer(true);
  const counted = money((await ledgerCash(db, A.location)) + fromUnits(50_000n).minor);
  const closed = await closeCashSession(db, {
    locationId: A.location,
    counted,
    note: "Sobrante de prueba",
    idempotencyKey: `seed-cash-${uniq()}`,
    actor: { userId: "seed" },
  });
  expect(closed.needsReview).toBe(true);
  return closed.sessionId;
}

/** Caja abierta con efectivo de sobra (una venta de $30.000 en efectivo, más la propina pedida). */
async function drawerWithCash(tip = 0n): Promise<void> {
  await cashDrawer(true);
  await seedSale({ kind: "cash", tip });
}

/** Un día pasado distinto en cada llamada, para cerrarlo o reabrirlo. */
const pastDay = () => addDays(businessDate(new Date(), TZ), -10 - Number(uniq()));

/** Una sesión real en la tabla (requireStaff lee de ahí la hora del ingreso y de la reautenticación). */
async function openSession(userId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(session).values({ id, token: randomUUID(), userId, expiresAt: new Date(Date.now() + 3_600_000) });
  return id;
}

/** Alguien con acceso y su sesión abierta (contraseña PASSWORD). */
async function personWithSession(role: Role, locationId: bigint, opts: { mustChangePassword?: boolean } = {}): Promise<Person> {
  const k = uniq();
  const { userId, staffId } = await createStaffUser(db, {
    locationId,
    name: `Persona ${role} ${k}`,
    email: `${role}-${locationId}-${k}@villa.test`,
    password: PASSWORD,
    role,
    mustChangePassword: opts.mustChangePassword,
  });
  if (role === "owner") await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, userId));
  return { id: userId, staffId, sessionId: await openSession(userId) };
}

/**
 * Simula la cookie de esa persona. Por defecto acaba de confirmar su identidad (las acciones
 * críticas pasan); `stale` deja la sesión vieja para probar que se exige reautenticación.
 */
async function signInAs(person: Person | null, opts: { stale?: boolean } = {}) {
  state.session = person ? { user: { id: person.id, name: "Prueba", email: "prueba@villa.test" }, session: { id: person.sessionId } } : null;
  if (!person) return;
  const old = new Date(Date.now() - 60 * 60_000);
  await db
    .update(session)
    .set(opts.stale ? { createdAt: old, reauthenticatedAt: null } : { reauthenticatedAt: new Date() })
    .where(eq(session.id, person.sessionId));
}

/** El staffId de quien tiene la sesión (para acciones sobre lo propio); sin sesión, uno cualquiera. */
function myStaffId(): bigint {
  const me = Object.values(A.users).find((p) => p.id === state.session?.user.id);
  return me?.staffId ?? A.dummy;
}

/** Huella de todo lo que una acción podría tocar (opcionalmente solo de una sede). */
async function fingerprint(locationId?: bigint): Promise<string> {
  const loc = locationId ?? null;
  const rows = await db.execute(sql`
    select
      (select coalesce(string_agg(id || ':' || status || ':' || staff_id || ':' || during::text, ',' order by id), '')
         from appointments where ${loc}::bigint is null or location_id = ${loc}) as appointments,
      (select count(*) from appointment_events where ${loc}::bigint is null or location_id = ${loc}) as events,
      (select coalesce(string_agg(id || ':' || name || ':' || active || ':' || price || ':' || commission_bps, ',' order by id), '')
         from services where ${loc}::bigint is null or location_id = ${loc}) as services,
      (select coalesce(string_agg(id || ':' || display_name || ':' || role || ':' || active || ':' || bookable_online, ',' order by id), '')
         from staff_members where ${loc}::bigint is null or location_id = ${loc}) as staff,
      (select coalesce(string_agg(row(l.*)::text, ',' order by id), '')
         from locations l where ${loc}::bigint is null or id = ${loc}) as locations,
      (select coalesce(string_agg(staff_id || ':' || weekday || ':' || start_min || '-' || end_min, ',' order by staff_id, weekday, start_min), '')
         from staff_schedules where ${loc}::bigint is null or location_id = ${loc}) as schedules,
      (select coalesce(string_agg(id || ':' || (cancelled_at is null), ',' order by id), '')
         from time_off where ${loc}::bigint is null or location_id = ${loc}) as time_off,
      (select count(*) from clients where ${loc}::bigint is null or location_id = ${loc}) as clients,
      (select count(*) from "user") as users,
      (select coalesce(string_agg(id || ':' || must_change_password, ',' order by id), '') from "user") as user_flags,
      (select coalesce(string_agg(user_id || ':' || password, ',' order by user_id), '') from account) as passwords,
      (select coalesce(string_agg(id, ',' order by id), '') from session) as sessions,
      (select count(*) from journal_entries where ${loc}::bigint is null or location_id = ${loc}) as journal,
      (select count(*) from day_close_events where ${loc}::bigint is null or location_id = ${loc}) as day_close,
      (select coalesce(string_agg(id || ':' || status, ',' order by id), '')
         from sales where ${loc}::bigint is null or location_id = ${loc}) as sales,
      (select coalesce(string_agg(id || ':' || (closed_at is null) || ':' || (reviewed_at is null), ',' order by id), '')
         from cash_sessions where ${loc}::bigint is null or location_id = ${loc}) as cash_sessions,
      (select count(*) from cash_movements where ${loc}::bigint is null or location_id = ${loc}) as cash_movements,
      (select count(*) from expenses where ${loc}::bigint is null or location_id = ${loc}) as expenses,
      (select coalesce(string_agg(id || ':' || status, ',' order by id), '')
         from void_requests where ${loc}::bigint is null or location_id = ${loc}) as void_requests,
      (select coalesce(string_agg(id || ':' || label || ':' || fee_bps || ':' || active, ',' order by id), '')
         from payment_methods where ${loc}::bigint is null or location_id = ${loc}) as payment_methods,
      (select coalesce(string_agg(id || ':' || name || ':' || account_code || ':' || active, ',' order by id), '')
         from expense_categories where ${loc}::bigint is null or location_id = ${loc}) as expense_categories
  `);
  return JSON.stringify(rows);
}

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  state.db = db;
  base = addDays(businessDate(new Date(), TZ), 3);
  const allDay = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: 0, endMin: 24 * 60 }));
  // Los dueños ya tienen el TOTP inscrito (si no, requireStaff los manda a inscribirlo).
  const person = (role: Role, locationId: bigint) => personWithSession(role, locationId);

  A.location = await createLocation(db, { name: "Villa" });
  A.users = { owner: await person("owner", A.location), reception: await person("reception", A.location), barber: await person("barber", A.location) };
  A.otherBarber = await addStaffMember(db, { locationId: A.location, displayName: "Otro barbero", role: "barber" });
  A.dummy = await addStaffMember(db, { locationId: A.location, displayName: "Persona de prueba", role: "barber" });
  for (const s of [A.users.barber.staffId, A.otherBarber]) await setWeeklySchedule(db, { locationId: A.location, staffId: s, blocks: allDay });
  A.service = (
    await createService(db, {
      locationId: A.location,
      draft: { name: "Corte", durationMin: 30, bufferMin: 10, price: fromUnits(30_000n), commissionBps: 4_000 },
    })
  ).id;
  A.client = (await findOrCreateClient(db, { locationId: A.location, name: "Juan Pérez", phone: "300 123 4567" })).id;
  A.methods = await methodsOf(A.location);
  const [category] = await db.select({ id: expenseCategories.id }).from(expenseCategories).where(eq(expenseCategories.locationId, A.location));
  A.category = category!.id;

  B.location = await createLocation(db, { name: "Otra sede" });
  B.owner = await person("owner", B.location);
  B.barber = await addStaffMember(db, { locationId: B.location, displayName: "Barbero B", role: "barber" });
  await setWeeklySchedule(db, { locationId: B.location, staffId: B.barber, blocks: allDay });
  B.service = (
    await createService(db, {
      locationId: B.location,
      draft: { name: "Corte B", durationMin: 30, bufferMin: 10, price: fromUnits(25_000n), commissionBps: 4_000 },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

// ─── Matriz rol × acción ─────────────────────────────────────────────────────

type Outcome = { ok: boolean; error?: string; data?: unknown };
type Attempt = () => Promise<Outcome>;

interface Case {
  name: string;
  /** La server action que se prueba (ver la guarda de completitud al final). */
  action: string;
  /** Quiénes pueden. Es la especificación: cambiarla es una decisión de negocio, no un arreglo de test. */
  allowed: readonly Role[];
  /** Prepara datos válidos y devuelve la llamada (lo preparado no cuenta como cambio). */
  prepare: () => Promise<Attempt>;
  /** El walk-in depende de la hora real; basta con que no lo frene el permiso. */
  lenient?: boolean;
}

const CASES: Case[] = [
  {
    name: "agenda · ver horarios libres",
    action: "loadSlots",
    allowed: ["owner", "reception"],
    prepare: async () => () => agenda.loadSlots({ serviceId: String(A.service), staffId: "any", date: base }),
  },
  {
    name: "agenda · buscar clientes",
    action: "findClients",
    allowed: ["owner", "reception"],
    prepare: async () => () => agenda.findClients("Juan"),
  },
  {
    name: "agenda · historial de una cita",
    action: "loadHistory",
    allowed: ["owner", "reception", "barber"],
    prepare: async () => {
      const id = await appointmentFor(A.users.barber.staffId);
      return () => agenda.loadHistory(String(id));
    },
  },
  {
    name: "agenda · agendar",
    action: "bookAppointment",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const { date, minute } = nextSlot();
      return () =>
        agenda.bookAppointment({
          serviceId: String(A.service),
          staffId: String(A.users.barber.staffId),
          date,
          minute,
          client: { kind: "existing", id: String(A.client) },
          idempotencyKey: `book-${uniq()}`,
        });
    },
  },
  {
    name: "agenda · walk-in",
    action: "startWalkIn",
    allowed: ["owner", "reception"],
    lenient: true,
    prepare: async () => () =>
      agenda.startWalkIn({ serviceId: String(A.service), staffId: "any", client: { kind: "none" }, idempotencyKey: `walk-${uniq()}` }),
  },
  {
    name: "agenda · cambiar estado de una cita del barbero",
    action: "setStatus",
    allowed: ["owner", "reception", "barber"],
    prepare: async () => {
      const id = await appointmentFor(A.users.barber.staffId);
      return () => agenda.setStatus({ appointmentId: String(id), to: "in_chair" });
    },
  },
  {
    name: "agenda · reprogramar",
    action: "reschedule",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const id = await appointmentFor(A.users.barber.staffId);
      const { date, minute } = nextSlot();
      return () => agenda.reschedule({ appointmentId: String(id), staffId: String(A.users.barber.staffId), date, minute });
    },
  },
  {
    name: "servicios · crear",
    action: "createServiceAction",
    allowed: ["owner"],
    prepare: async () => {
      const name = `Servicio ${uniq()}`;
      return () => servicios.createServiceAction({ name, priceUnits: "20000", durationMin: 30, bufferMin: 5, commission: "40", active: true });
    },
  },
  {
    name: "servicios · cambiar precio y comisión",
    action: "updateServiceAction",
    allowed: ["owner"],
    prepare: async () => {
      const price = String(30_000 + Number(uniq()));
      return () =>
        servicios.updateServiceAction({
          serviceId: String(A.service),
          name: "Corte",
          priceUnits: price,
          durationMin: 30,
          bufferMin: 10,
          commission: "40",
          active: true,
        });
    },
  },
  {
    name: "servicios · retirar",
    action: "setServiceActiveAction",
    allowed: ["owner"],
    prepare: async () => {
      const svc = await createService(db, {
        locationId: A.location,
        draft: { name: `Temporal ${uniq()}`, durationMin: 20, bufferMin: 0, price: fromUnits(10_000n), commissionBps: 3_000 },
      });
      return () => servicios.setServiceActiveAction({ serviceId: String(svc.id), active: false });
    },
  },
  {
    name: "personal · agregar persona",
    action: "createStaffAction",
    allowed: ["owner"],
    prepare: async () => {
      const name = `Nuevo ${uniq()}`;
      return () => personal.createStaffAction({ withAccess: false, name, role: "barber" });
    },
  },
  {
    name: "personal · crear una cuenta de dueño",
    action: "createStaffAction",
    allowed: ["owner"],
    prepare: async () => {
      const k = uniq();
      return () =>
        personal.createStaffAction({ withAccess: true, name: `Socio ${k}`, role: "owner", email: `socio${k}@villa.test`, password: PASSWORD });
    },
  },
  {
    name: "personal · ascender a dueño",
    action: "updateStaffProfileAction",
    allowed: ["owner"],
    prepare: async () => {
      const target = await addStaffMember(db, { locationId: A.location, displayName: `Ascenso ${uniq()}`, role: "barber" });
      return () => personal.updateStaffProfileAction({ staffId: String(target), displayName: "Ascendido", role: "owner", active: true });
    },
  },
  {
    name: "personal · guardar horario",
    action: "saveScheduleAction",
    allowed: ["owner"],
    prepare: async () => {
      const end = `${String(10 + (Number(uniq()) % 9)).padStart(2, "0")}:00`;
      return () => personal.saveScheduleAction({ staffId: String(A.dummy), blocks: [{ weekday: 1, start: "09:00", end }] });
    },
  },
  {
    name: "bloqueos · ausencia de otra persona",
    action: "addStaffTimeOffAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const date = addDays(base, 100 + Number(uniq()));
      return () =>
        bloqueos.addStaffTimeOffAction({ staffId: String(A.dummy), kind: "absence", range: { allDay: true, fromDate: date, toDate: date } });
    },
  },
  {
    name: "bloqueos · bloquear el tiempo de otra persona",
    action: "addStaffTimeOffAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const date = addDays(base, 100 + Number(uniq()));
      return () =>
        bloqueos.addStaffTimeOffAction({
          staffId: String(A.otherBarber),
          kind: "block",
          range: { allDay: false, date, startTime: "12:00", endTime: "13:00" },
        });
    },
  },
  {
    name: "bloqueos · bloquear el tiempo propio",
    action: "addStaffTimeOffAction",
    allowed: ["owner", "reception", "barber"],
    prepare: async () => {
      const date = addDays(base, 100 + Number(uniq()));
      return () =>
        bloqueos.addStaffTimeOffAction({
          staffId: String(myStaffId()),
          kind: "block",
          range: { allDay: false, date, startTime: "12:00", endTime: "13:00" },
        });
    },
  },
  {
    name: "bloqueos · registrarse una ausencia propia (vacaciones)",
    action: "addStaffTimeOffAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const date = addDays(base, 100 + Number(uniq()));
      return () =>
        bloqueos.addStaffTimeOffAction({ staffId: String(myStaffId()), kind: "absence", range: { allDay: true, fromDate: date, toDate: date } });
    },
  },
  {
    name: "bloqueos · cierre de la sede",
    action: "addClosureAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const date = addDays(base, 300 + Number(uniq()));
      return () => bloqueos.addClosureAction({ fromDate: date, toDate: date, reason: "Festivo" });
    },
  },
  {
    name: "bloqueos · anular la ausencia de otra persona",
    action: "cancelTimeOffAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const id = await timeOffFor(A.dummy, 200 + Number(uniq()));
      return () => bloqueos.cancelTimeOffAction({ timeOffId: String(id) });
    },
  },
  {
    name: "bloqueos · anular un bloqueo propio",
    action: "cancelTimeOffAction",
    allowed: ["owner", "reception", "barber"],
    prepare: async () => {
      // Uno por persona: la llamada anula el de quien tenga la sesión.
      const k = 200 + Number(uniq());
      const ids = new Map<bigint, bigint>();
      for (const p of Object.values(A.users)) ids.set(p.staffId, await timeOffFor(p.staffId, k));
      return () => bloqueos.cancelTimeOffAction({ timeOffId: String(ids.get(myStaffId()) ?? 0n) });
    },
  },
  {
    name: "bloqueos · anular un cierre de la sede",
    action: "cancelTimeOffAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const date = addDays(base, 400 + Number(uniq()));
      const { id } = await addTimeOff(db, {
        locationId: A.location,
        staffId: null,
        kind: "absence",
        createdBy: "seed",
        allDay: true,
        fromDate: date,
        toDate: date,
      });
      return () => bloqueos.cancelTimeOffAction({ timeOffId: String(id) });
    },
  },
  {
    name: "ajustes · reglas de la sede y reserva en línea",
    action: "updateBookingSettingsAction",
    allowed: ["owner"],
    prepare: async () => {
      const n = Number(uniq());
      return () =>
        ajustes.updateBookingSettingsAction({
          publicBookingEnabled: false,
          publicPhone: "300 123 4567",
          address: `Calle ${n}`,
          mapsUrl: "",
          slotStepMin: 15,
          minAdvanceMin: 60 + (n % 10) * 15,
          maxAdvanceDays: 30,
          holdMin: 10,
          freeCancelHours: 4,
          noShowGraceMin: 15,
          maxActivePerClient: 2,
        });
    },
  },
  {
    name: "ajustes · quién atiende en línea",
    action: "setStaffBookableAction",
    allowed: ["owner"],
    prepare: async () => {
      const [row] = await db.select({ bookable: staffMembers.bookableOnline }).from(staffMembers).where(eq(staffMembers.id, A.dummy));
      return () => ajustes.setStaffBookableAction({ staffId: String(A.dummy), bookable: !row?.bookable });
    },
  },
  {
    name: "personal · poner una contraseña temporal",
    action: "resetStaffPasswordAction",
    allowed: ["owner"],
    prepare: async () => {
      const target = await personWithSession("barber", A.location);
      return () => personal.resetStaffPasswordAction({ staffId: String(target.staffId), password: TEMP_PASSWORD });
    },
  },
  {
    name: "personal · cerrar las sesiones de alguien",
    action: "revokeStaffSessionsAction",
    allowed: ["owner"],
    prepare: async () => {
      const target = await personWithSession("barber", A.location);
      return () => personal.revokeStaffSessionsAction({ staffId: String(target.staffId) });
    },
  },
  {
    name: "cuenta · cambiar la contraseña propia",
    action: "changeOwnPasswordAction",
    allowed: ["owner", "reception", "barber"],
    prepare: async () => async () => {
      // Ida y vuelta: la contraseña de la persona queda como estaba para los demás casos.
      const there = await cuenta.changeOwnPasswordAction({ currentPassword: PASSWORD, newPassword: TEMP_PASSWORD });
      if (!there.ok) return there;
      return cuenta.changeOwnPasswordAction({ currentPassword: TEMP_PASSWORD, newPassword: PASSWORD });
    },
  },
  {
    name: "cuenta · confirmar identidad",
    action: "reauthenticateAction",
    allowed: ["owner", "reception", "barber"],
    // Con TOTP (los dueños) se confirma con el código; sin él, con la contraseña.
    prepare: async () => () =>
      cuenta.reauthenticateAction(
        state.session?.user.id === A.users.owner.id ? { method: "totp", code: state.totpCode } : { method: "password", password: PASSWORD },
      ),
  },
  // Con el TOTP activo (los dueños) pasan; sin él, responden que no lo tienen: no es un tema de
  // permiso (lenient). Que la contraseña sola no basta se prueba aparte, más abajo.
  {
    name: "cuenta · códigos de respaldo nuevos",
    action: "regenerateBackupCodesAction",
    allowed: ["owner", "reception", "barber"],
    lenient: true,
    prepare: async () => () => cuenta.regenerateBackupCodesAction({ password: PASSWORD, code: state.totpCode }),
  },
  {
    name: "cuenta · desactivar la verificación en dos pasos",
    action: "disableTwoFactorAction",
    allowed: ["owner", "reception", "barber"],
    lenient: true,
    prepare: async () => () => cuenta.disableTwoFactorAction({ password: PASSWORD, code: state.totpCode }),
  },
  {
    name: "sesión · salir",
    action: "signOut",
    allowed: ["owner", "reception", "barber"],
    // Siempre termina en /ingresar; con sesión eso es el éxito (sin sesión, la matriz espera el redirect).
    prepare: async () => async () => {
      const hadSession = state.session !== null;
      try {
        await panelRoot.signOut();
      } catch (err) {
        if (hadSession && (err as { url?: string }).url === "/ingresar") return { ok: true };
        throw err;
      }
      return { ok: false, error: "signOut no redirigió" };
    },
  },
  // ── Sprint 4: cobro, caja, gastos y anulaciones ──
  {
    name: "cobro · abrir el cobro de una cita",
    action: "loadCheckout",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const id = await chairAppointment();
      return () => cobro.loadCheckout({ appointmentId: String(id) });
    },
  },
  {
    name: "cobro · cobrar una cita con tarjeta",
    action: "checkoutAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const id = await chairAppointment();
      const units = String((await servicePrice()) / 100n);
      return () =>
        cobro.checkoutAction({
          appointmentId: String(id),
          extras: [],
          discounts: [],
          tips: [],
          payments: [{ methodId: String(A.methods.card), amountUnits: units }],
          idempotencyKey: `cobro-${uniq()}`,
        });
    },
  },
  {
    name: "cobro · abrir el cobro sin cita",
    action: "loadWalkInCheckout",
    allowed: ["owner", "reception"],
    prepare: async () => () => cobro.loadWalkInCheckout(),
  },
  {
    name: "cobro · cobrar sin cita (walk-in) con tarjeta",
    action: "checkoutAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const units = String((await servicePrice()) / 100n);
      return () =>
        cobro.checkoutAction({
          appointmentId: null,
          client: { kind: "existing", id: String(A.client) },
          extras: [{ serviceId: String(A.service), staffId: String(A.users.barber.staffId) }],
          discounts: [],
          tips: [],
          payments: [{ methodId: String(A.methods.card), amountUnits: units }],
          idempotencyKey: `cobro-${uniq()}`,
        });
    },
  },
  {
    name: "cobro · pedir la anulación de una venta",
    action: "requestVoidAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const saleId = await seedSale();
      return () => cobro.requestVoidAction({ saleId: String(saleId), reason: "Se cobró dos veces", idempotencyKey: `anular-${uniq()}` });
    },
  },
  {
    name: "caja · ver la caja",
    action: "loadCashView",
    allowed: ["owner", "reception"],
    prepare: async () => () => caja.loadCashView(),
  },
  {
    name: "caja · abrir el turno",
    action: "openCashSessionAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      await cashDrawer(false);
      const units = (await ledgerCash(db, A.location)) / 100n;
      return () => caja.openCashSessionAction({ countedUnits: String(units), idempotencyKey: `abrir-${uniq()}` });
    },
  },
  {
    name: "caja · cerrar el turno",
    action: "closeCashSessionAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      await cashDrawer(true);
      const units = (await ledgerCash(db, A.location)) / 100n;
      // Conteo a ciegas: quien no es dueño siempre deja nota.
      return () => caja.closeCashSessionAction({ countedUnits: String(units), note: "Conteo de prueba", idempotencyKey: `cerrar-${uniq()}` });
    },
  },
  {
    name: "caja · dar por revisado un cierre con diferencia",
    action: "markCashSessionReviewedAction",
    allowed: ["owner"],
    prepare: async () => {
      const id = await flaggedSession();
      return () => caja.markCashSessionReviewedAction({ sessionId: String(id) });
    },
  },
  {
    name: "caja · gasto pagado de la caja",
    action: "addExpenseAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      await drawerWithCash();
      return () =>
        caja.addExpenseAction({
          categoryId: String(A.category),
          amountUnits: "5000",
          paidFrom: "cash",
          description: "Jabón y toallas",
          idempotencyKey: `gasto-${uniq()}`,
        });
    },
  },
  {
    name: "caja · gasto pagado del banco",
    action: "addExpenseAction",
    allowed: ["owner"],
    prepare: async () => () =>
      caja.addExpenseAction({
        categoryId: String(A.category),
        amountUnits: "800000",
        paidFrom: "bank",
        description: "Arriendo del local",
        idempotencyKey: `gasto-${uniq()}`,
      }),
  },
  {
    name: "caja · pagar propinas en efectivo",
    action: "payTipsAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      await drawerWithCash(2_000n);
      return () => caja.payTipsAction({ staffId: String(A.users.barber.staffId), amountUnits: "2000", idempotencyKey: `propinas-${uniq()}` });
    },
  },
  {
    name: "caja · consignar efectivo",
    action: "cashDepositAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      await drawerWithCash();
      return () => caja.cashDepositAction({ amountUnits: "10000", idempotencyKey: `consignar-${uniq()}` });
    },
  },
  {
    name: "caja · cerrar el día",
    action: "closeDayAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      await cashDrawer(false);
      const day = pastDay();
      return () => caja.closeDayAction({ businessDate: day });
    },
  },
  {
    name: "caja · reabrir un día cerrado",
    action: "reopenDayAction",
    allowed: ["owner"],
    prepare: async () => {
      await cashDrawer(false);
      const day = pastDay();
      await closeBusinessDay(db, { locationId: A.location, businessDate: day, actor: { userId: "seed" } });
      return () => caja.reopenDayAction({ businessDate: day, reason: "Faltó registrar un gasto" });
    },
  },
  {
    name: "anulaciones · ver la cola",
    action: "loadVoidQueue",
    allowed: ["owner", "reception"],
    prepare: async () => () => anulaciones.loadVoidQueue(),
  },
  {
    name: "anulaciones · aprobar una anulación",
    action: "decideVoidAction",
    allowed: ["owner"],
    prepare: async () => {
      const saleId = await seedSale();
      const { requestId } = await requestVoid(db, {
        locationId: A.location,
        saleId,
        reason: "Se cobró dos veces",
        idempotencyKey: `seed-anular-${uniq()}`,
        actor: { userId: A.users.reception.id },
      });
      return () => anulaciones.decideVoidAction({ requestId: String(requestId), approve: true, note: "", idempotencyKey: `decidir-${uniq()}` });
    },
  },
  {
    name: "ajustes · ver medios de pago, categorías y reglas del cobro",
    action: "loadCheckoutSettings",
    allowed: ["owner"],
    prepare: async () => () => ajustes.loadCheckoutSettings(),
  },
  {
    name: "ajustes · editar un medio de pago",
    action: "savePaymentMethodAction",
    allowed: ["owner"],
    prepare: async () => () =>
      ajustes.savePaymentMethodAction({ id: String(A.methods.card), kind: "card", label: `Tarjeta ${uniq()}`, feeBps: "0", active: true }),
  },
  {
    name: "ajustes · editar una categoría de gasto",
    action: "saveExpenseCategoryAction",
    allowed: ["owner"],
    prepare: async () => () =>
      ajustes.saveExpenseCategoryAction({ id: String(A.category), name: `Categoría ${uniq()}`, accountCode: "5195", active: true }),
  },
  {
    name: "ajustes · reglas del cobro",
    action: "updateCheckoutRulesAction",
    allowed: ["owner"],
    prepare: async () => {
      const n = Number(uniq());
      return () =>
        ajustes.updateCheckoutRulesAction({
          commissionBase: "net",
          maxDiscountBps: String(1_000 + (n % 20) * 100),
          receptionCanDiscount: false,
          tipsBearCardFees: false,
          cashReviewThresholdUnits: "20000",
        });
    },
  },
];

const ROLES: Role[] = ["owner", "reception", "barber"];

describe.each(CASES)("$name", (c) => {
  it.each(ROLES)("como %s", async (role) => {
    const attempt = await c.prepare();
    await signInAs(A.users[role]);
    if (c.allowed.includes(role)) {
      const result = await attempt();
      if (c.lenient) expect(result.ok || !/permiso/i.test(result.error ?? ""), JSON.stringify(result)).toBe(true);
      else expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    } else {
      const before = await fingerprint();
      await expect(attempt()).rejects.toMatchObject({ url: "/panel?sin-permiso=1" });
      expect(await fingerprint()).toBe(before);
    }
  });

  it("sin sesión: va a /ingresar sin tocar nada", async () => {
    const attempt = await c.prepare();
    await signInAs(null);
    const before = await fingerprint();
    await expect(attempt()).rejects.toMatchObject({ url: "/ingresar" });
    expect(await fingerprint()).toBe(before);
  });
});

describe("cuenta válida sin acceso a ninguna sede", () => {
  it("se manda a /ingresar?sin-acceso=1", async () => {
    await signInAs({ id: "usuario-sin-sede", staffId: 0n, sessionId: "sesion-sin-sede" });
    await expect(agenda.findClients("Juan")).rejects.toMatchObject({ url: "/ingresar?sin-acceso=1" });
  });
});

// ─── El barbero y las citas ajenas ───────────────────────────────────────────

describe("barbero frente a la cita de otro barbero", () => {
  it("no puede cambiarle el estado ni ver su historial", async () => {
    const id = await appointmentFor(A.otherBarber);
    await signInAs(A.users.barber);
    const before = await fingerprint();
    expect(await agenda.setStatus({ appointmentId: String(id), to: "in_chair" })).toMatchObject({ ok: false });
    expect(await agenda.loadHistory(String(id))).toEqual({ ok: true, data: [] });
    expect(await fingerprint()).toBe(before);
  });
});

// ─── Aislamiento entre sedes (IDOR) ──────────────────────────────────────────

const CROSS_LOCATION: { name: string; prepare: () => Promise<Attempt> }[] = [
  {
    name: "cancelar una cita",
    prepare: async () => {
      const id = await appointmentFor(A.users.barber.staffId);
      return () => agenda.setStatus({ appointmentId: String(id), to: "cancelled", cancelReason: "staff" });
    },
  },
  {
    name: "reprogramar una cita hacia su sede",
    prepare: async () => {
      const id = await appointmentFor(A.users.barber.staffId);
      const { date, minute } = nextSlot();
      return () => agenda.reschedule({ appointmentId: String(id), staffId: String(B.barber), date, minute });
    },
  },
  {
    name: "agendar con un servicio de esta sede",
    prepare: async () => {
      const { date, minute } = nextSlot();
      return () =>
        agenda.bookAppointment({
          serviceId: String(A.service),
          staffId: String(B.barber),
          date,
          minute,
          client: { kind: "new", name: "Intruso", phone: "301 000 0000" },
          idempotencyKey: `x-${uniq()}`,
        });
    },
  },
  {
    name: "agendar a un cliente de esta sede",
    prepare: async () => {
      const { date, minute } = nextSlot();
      return () =>
        agenda.bookAppointment({
          serviceId: String(B.service),
          staffId: String(B.barber),
          date,
          minute,
          client: { kind: "existing", id: String(A.client) },
          idempotencyKey: `x-${uniq()}`,
        });
    },
  },
  {
    name: "agendar con un barbero de esta sede",
    prepare: async () => {
      const { date, minute } = nextSlot();
      return () =>
        agenda.bookAppointment({
          serviceId: String(B.service),
          staffId: String(A.users.barber.staffId),
          date,
          minute,
          client: { kind: "new", name: "Intruso", phone: "301 000 0001" },
          idempotencyKey: `x-${uniq()}`,
        });
    },
  },
  {
    name: "editar un servicio",
    prepare: async () => () =>
      servicios.updateServiceAction({
        serviceId: String(A.service),
        name: "Hackeado",
        priceUnits: "1",
        durationMin: 30,
        bufferMin: 10,
        commission: "100",
        active: true,
      }),
  },
  { name: "retirar un servicio", prepare: async () => () => servicios.setServiceActiveAction({ serviceId: String(A.service), active: false }) },
  {
    name: "ascender a alguien a dueño",
    prepare: async () => () =>
      personal.updateStaffProfileAction({ staffId: String(A.users.reception.staffId), displayName: "X", role: "owner", active: true }),
  },
  { name: "borrar un horario", prepare: async () => () => personal.saveScheduleAction({ staffId: String(A.users.barber.staffId), blocks: [] }) },
  {
    name: "poner una ausencia",
    prepare: async () => {
      const date = addDays(base, 50);
      return () =>
        bloqueos.addStaffTimeOffAction({
          staffId: String(A.users.barber.staffId),
          kind: "absence",
          range: { allDay: true, fromDate: date, toDate: date },
        });
    },
  },
  {
    name: "anular una ausencia",
    prepare: async () => {
      const id = await timeOffFor(A.dummy, 250 + Number(uniq()));
      return () => bloqueos.cancelTimeOffAction({ timeOffId: String(id) });
    },
  },
  {
    name: "sacar a un barbero de la reserva en línea",
    prepare: async () => () => ajustes.setStaffBookableAction({ staffId: String(A.users.barber.staffId), bookable: false }),
  },
  {
    name: "ponerle una contraseña temporal a alguien",
    prepare: async () => () => personal.resetStaffPasswordAction({ staffId: String(A.users.barber.staffId), password: TEMP_PASSWORD }),
  },
  {
    name: "cerrarle las sesiones a alguien",
    prepare: async () => () => personal.revokeStaffSessionsAction({ staffId: String(A.users.reception.staffId) }),
  },
  {
    name: "abrir el cobro de una cita",
    prepare: async () => {
      const id = await chairAppointment();
      return () => cobro.loadCheckout({ appointmentId: String(id) });
    },
  },
  {
    name: "cobrar una cita",
    prepare: async () => {
      const id = await chairAppointment();
      const theirs = await methodsOf(B.location);
      return () =>
        cobro.checkoutAction({
          appointmentId: String(id),
          extras: [],
          discounts: [],
          tips: [],
          payments: [{ methodId: String(theirs.card), amountUnits: "30000" }],
          idempotencyKey: `x-${uniq()}`,
        });
    },
  },
  {
    name: "cobrar sin cita con un servicio y un cliente de esta sede",
    prepare: async () => () =>
      cobro.checkoutAction({
        appointmentId: null,
        client: { kind: "existing", id: String(A.client) },
        extras: [{ serviceId: String(A.service), staffId: String(B.barber) }],
        discounts: [],
        tips: [],
        payments: [{ methodId: String(A.methods.card), amountUnits: "30000" }],
        idempotencyKey: `x-${uniq()}`,
      }),
  },
  {
    name: "pedir la anulación de una venta",
    prepare: async () => {
      const saleId = await seedSale();
      return () => cobro.requestVoidAction({ saleId: String(saleId), reason: "Intruso", idempotencyKey: `x-${uniq()}` });
    },
  },
  {
    name: "aprobar la anulación de una venta",
    prepare: async () => {
      const saleId = await seedSale();
      const { requestId } = await requestVoid(db, {
        locationId: A.location,
        saleId,
        reason: "Se cobró dos veces",
        idempotencyKey: `seed-anular-${uniq()}`,
        actor: { userId: A.users.reception.id },
      });
      return () => anulaciones.decideVoidAction({ requestId: String(requestId), approve: true, note: "", idempotencyKey: `x-${uniq()}` });
    },
  },
  {
    name: "pagarle propinas a un barbero",
    prepare: async () => () => caja.payTipsAction({ staffId: String(A.users.barber.staffId), amountUnits: "1000", idempotencyKey: `x-${uniq()}` }),
  },
  {
    name: "registrar un gasto con una categoría",
    prepare: async () => () =>
      caja.addExpenseAction({ categoryId: String(A.category), amountUnits: "1000", paidFrom: "bank", description: "Intruso", idempotencyKey: `x-${uniq()}` }),
  },
  {
    name: "editar un medio de pago",
    prepare: async () => () =>
      ajustes.savePaymentMethodAction({ id: String(A.methods.card), kind: "card", label: "Hackeado", feeBps: "9000", active: false }),
  },
  {
    name: "editar una categoría de gasto",
    prepare: async () => () => ajustes.saveExpenseCategoryAction({ id: String(A.category), name: "Hackeada", accountCode: "5195", active: false }),
  },
  {
    name: "dar por revisado un cierre de caja",
    prepare: async () => {
      const id = await flaggedSession();
      return () => caja.markCashSessionReviewedAction({ sessionId: String(id) });
    },
  },
];

describe("el dueño de otra sede no alcanza nada de esta", () => {
  it.each(CROSS_LOCATION)("no puede $name", async ({ prepare }) => {
    const attempt = await prepare();
    await signInAs(B.owner);
    const before = await fingerprint(A.location);
    const result = await attempt();
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(await fingerprint(A.location)).toBe(before);
  });

  it("no encuentra clientes de esta sede ni ve el historial de sus citas", async () => {
    const id = await appointmentFor(A.users.barber.staffId);
    await signInAs(B.owner);
    expect(await agenda.findClients("Juan")).toEqual({ ok: true, data: [] });
    expect(await agenda.loadHistory(String(id))).toEqual({ ok: true, data: [] });
  });
});

// ─── Reautenticación para las acciones críticas ──────────────────────────────

describe("acciones críticas con una sesión vieja", () => {
  it("crear un dueño pide confirmar identidad y no toca nada; tras confirmar, pasa", async () => {
    const k = uniq();
    const createOwner = () =>
      personal.createStaffAction({ withAccess: true, name: `Socia ${k}`, role: "owner", email: `socia${k}@villa.test`, password: PASSWORD });
    await signInAs(A.users.owner, { stale: true });
    const before = await fingerprint();
    expect(await createOwner()).toMatchObject({ ok: false, code: "reauth_required" });
    expect(await fingerprint()).toBe(before);

    expect(await cuenta.reauthenticateAction({ method: "totp", code: "000000" })).toMatchObject({
      ok: false,
      error: "El código no es correcto.",
    });
    expect(await createOwner()).toMatchObject({ ok: false, code: "reauth_required" });

    expect(await cuenta.reauthenticateAction({ method: "totp", code: state.totpCode })).toEqual({ ok: true, data: undefined });
    expect(await createOwner()).toMatchObject({ ok: true });
  });

  it("con la verificación en dos pasos activa, la contraseña sola no confirma; un código de respaldo sí", async () => {
    const owner = await personWithSession("owner", A.location);
    await signInAs(owner, { stale: true });
    const rename = () => personal.updateStaffProfileAction({ staffId: String(owner.staffId), displayName: `Dueña ${uniq()}`, role: "owner", active: true });
    expect(await cuenta.reauthenticateAction({ method: "password", password: PASSWORD })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/código de tu app o un código de respaldo/),
    });
    expect(await rename()).toMatchObject({ ok: false, code: "reauth_required" });
    expect(await cuenta.reauthenticateAction({ method: "backup", code: "zzzzz-99999" })).toMatchObject({ ok: false, error: expect.stringMatching(/respaldo/) });
    expect(await cuenta.reauthenticateAction({ method: "backup", code: state.backupCode })).toMatchObject({ ok: true });
    expect(await rename()).toMatchObject({ ok: true });
  });

  it("sin TOTP, la contraseña sí confirma", async () => {
    const barber = await personWithSession("barber", A.location);
    await signInAs(barber, { stale: true });
    expect(await cuenta.reauthenticateAction({ method: "password", password: "no-es-la-clave" })).toMatchObject({ ok: false, error: "La contraseña no es correcta." });
    expect(await cuenta.reauthenticateAction({ method: "password", password: PASSWORD })).toEqual({ ok: true, data: undefined });
  });

  it("concurrencia: 20 códigos malos en paralelo verifican a lo sumo 5; el resto queda bloqueado", async () => {
    const owner = await personWithSession("owner", A.location);
    await signInAs(owner, { stale: true });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => cuenta.reauthenticateAction({ method: "totp", code: String(100000 + i) })));
    const verified = results.filter((r) => !r.ok && r.error === "El código no es correcto.").length;
    expect(verified).toBeGreaterThan(0);
    expect(verified).toBeLessThanOrEqual(5);
    expect(results.filter((r) => !r.ok && /Demasiados intentos/.test(r.error))).toHaveLength(20 - verified);
    // Bloqueado: ni el código correcto pasa.
    expect(await cuenta.reauthenticateAction({ method: "totp", code: state.totpCode })).toMatchObject({ ok: false, error: expect.stringMatching(/Demasiados intentos/) });
  });

  it("concurrencia: cambiar la contraseña con 20 actuales malas en paralelo verifica a lo sumo 5", async () => {
    const barber = await personWithSession("barber", A.location);
    await signInAs(barber);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => cuenta.changeOwnPasswordAction({ currentPassword: `mala-${i}-larga`, newPassword: TEMP_PASSWORD })),
    );
    const verified = results.filter((r) => !r.ok && r.error === "La contraseña actual no es correcta.").length;
    expect(verified).toBeLessThanOrEqual(5);
    expect(results.filter((r) => !r.ok && /Demasiados intentos/.test(r.error))).toHaveLength(20 - verified);
  });

  it("los ajustes y movimientos de dinero la piden; no tocan nada sin ella y pasan tras confirmar", async () => {
    const ownerTarget = await personWithSession("owner", A.location);
    await signInAs(A.users.owner, { stale: true });
    await drawerWithCash();
    const price = String(31_000 + Number(uniq()));
    const attempts = [
      () => ajustes.savePaymentMethodAction({ id: String(A.methods.card), kind: "card", label: `Tarjeta ${uniq()}`, feeBps: "150", active: true }),
      () => ajustes.saveExpenseCategoryAction({ id: String(A.category), name: `Categoría ${uniq()}`, accountCode: "5195", active: true }),
      () => ajustes.updateCheckoutRulesAction({ commissionBase: "gross", maxDiscountBps: "500", receptionCanDiscount: true, tipsBearCardFees: true }),
      () => servicios.createServiceAction({ name: `Nuevo ${uniq()}`, priceUnits: "20000", durationMin: 30, bufferMin: 5, commission: "40", active: true }),
      () =>
        servicios.updateServiceAction({ serviceId: String(A.service), name: "Corte", priceUnits: price, durationMin: 30, bufferMin: 10, commission: "40", active: true }),
      () => personal.updateStaffProfileAction({ staffId: String(ownerTarget.staffId), displayName: `Socia ${uniq()}`, role: "owner", active: true }),
      () => personal.updateStaffProfileAction({ staffId: String(ownerTarget.staffId), displayName: "Socia", role: "owner", active: false }),
      () =>
        caja.addExpenseAction({ categoryId: String(A.category), amountUnits: "700000", paidFrom: "bank", description: "Arriendo", idempotencyKey: `banco-${uniq()}` }),
    ];
    const before = await fingerprint();
    for (const attempt of attempts) expect(await attempt(), attempt.toString()).toMatchObject({ ok: false, code: "reauth_required" });
    expect(await fingerprint()).toBe(before);

    expect(await cuenta.reauthenticateAction({ method: "totp", code: state.totpCode })).toMatchObject({ ok: true });
    for (const attempt of attempts) expect(await attempt(), attempt.toString()).toMatchObject({ ok: true });
  });

  it("lo que no mueve dinero no la pide: nombre o duración de un servicio, un gasto de caja", async () => {
    await signInAs(A.users.owner, { stale: true });
    await drawerWithCash();
    const price = (await servicePrice()) / 100n;
    expect(
      await servicios.updateServiceAction({
        serviceId: String(A.service),
        name: "Corte",
        priceUnits: String(price),
        durationMin: 30,
        bufferMin: 10,
        commission: "40",
        active: true,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await caja.addExpenseAction({ categoryId: String(A.category), amountUnits: "2000", paidFrom: "cash", description: "Jabón", idempotencyKey: `caja-${uniq()}` }),
    ).toMatchObject({ ok: true });
  });

  it("ascender a dueño, cambiar un rol y poner contraseñas también la piden; el código de la app sirve", async () => {
    const target = await personWithSession("barber", A.location);
    await signInAs(A.users.owner, { stale: true });
    const before = await fingerprint();
    for (const attempt of [
      () => personal.updateStaffProfileAction({ staffId: String(target.staffId), displayName: "Ascendido", role: "owner", active: true }),
      () => personal.updateStaffProfileAction({ staffId: String(target.staffId), displayName: "Recepción", role: "reception", active: true }),
      () => personal.resetStaffPasswordAction({ staffId: String(target.staffId), password: TEMP_PASSWORD }),
    ]) {
      expect(await attempt()).toMatchObject({ ok: false, code: "reauth_required" });
    }
    expect(await fingerprint()).toBe(before);

    expect(await cuenta.reauthenticateAction({ method: "totp", code: "000000" })).toMatchObject({ ok: false, error: "El código no es correcto." });
    expect(await cuenta.reauthenticateAction({ method: "totp", code: state.totpCode })).toMatchObject({ ok: true });
    expect(
      await personal.updateStaffProfileAction({ staffId: String(target.staffId), displayName: "Recepción", role: "reception", active: true }),
    ).toMatchObject({ ok: true });
  });

  it("cambiar solo el nombre no la pide", async () => {
    await signInAs(A.users.owner, { stale: true });
    expect(
      await personal.updateStaffProfileAction({ staffId: String(A.dummy), displayName: `Persona ${uniq()}`, role: "barber", active: true }),
    ).toMatchObject({ ok: true });
  });

  it("sin TOTP inscrito no se puede confirmar con código", async () => {
    await signInAs(A.users.barber);
    expect(await cuenta.reauthenticateAction({ method: "totp", code: state.totpCode })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Usa tu contraseña/),
    });
  });
});

// ─── Contraseña temporal y verificación en dos pasos obligatoria ─────────────

describe("cuenta sin terminar de configurar", () => {
  it("un dueño sin TOTP no entra a nada del panel: va a inscribirlo", async () => {
    const owner = await personWithSession("owner", A.location);
    await db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, owner.id));
    await signInAs(owner);
    const before = await fingerprint();
    await expect(agenda.findClients("Juan")).rejects.toMatchObject({ url: "/cuenta/verificacion" });
    await expect(personal.createStaffAction({ withAccess: false, name: "Nadie", role: "barber" })).rejects.toMatchObject({
      url: "/cuenta/verificacion",
    });
    await expect(cuenta.reauthenticateAction({ method: "password", password: PASSWORD })).rejects.toMatchObject({ url: "/cuenta/verificacion" });
    expect(await fingerprint()).toBe(before);
  });

  it("con contraseña temporal solo puede cambiarla; después entra normal", async () => {
    const barber = await personWithSession("barber", A.location, { mustChangePassword: true });
    await signInAs(barber);
    await expect(agenda.loadHistory("1")).rejects.toMatchObject({ url: "/cuenta/clave" });
    await expect(cuenta.reauthenticateAction({ method: "password", password: PASSWORD })).rejects.toMatchObject({ url: "/cuenta/clave" });

    expect(await cuenta.changeOwnPasswordAction({ currentPassword: "no-es-la-clave", newPassword: TEMP_PASSWORD })).toMatchObject({
      ok: false,
      error: "La contraseña actual no es correcta.",
    });
    expect(await cuenta.changeOwnPasswordAction({ currentPassword: PASSWORD, newPassword: TEMP_PASSWORD })).toMatchObject({ ok: true });
    expect(await agenda.loadHistory("1")).toMatchObject({ ok: true });
  });

  it("el dueño reinicia la contraseña de alguien: queda temporal y sin sesiones", async () => {
    const barber = await personWithSession("barber", A.location);
    await signInAs(A.users.owner);
    expect(await personal.resetStaffPasswordAction({ staffId: String(barber.staffId), password: TEMP_PASSWORD })).toMatchObject({ ok: true });
    expect(await db.select().from(session).where(eq(session.userId, barber.id))).toEqual([]);
    const [u] = await db.select({ must: user.mustChangePassword }).from(user).where(eq(user.id, barber.id));
    expect(u?.must).toBe(true);
  });

  it("nadie se reinicia la contraseña ni se cierra la sesión a sí mismo desde el panel", async () => {
    await signInAs(A.users.owner);
    expect(await personal.resetStaffPasswordAction({ staffId: String(A.users.owner.staffId), password: TEMP_PASSWORD })).toMatchObject({
      ok: false,
    });
    expect(await personal.revokeStaffSessionsAction({ staffId: String(A.users.owner.staffId) })).toMatchObject({ ok: false });
  });
});

// ─── Conteo a ciegas (sprint 4, MEDIUM-3) ────────────────────────────────────

describe("conteo a ciegas", () => {
  it("con la caja abierta, solo el dueño recibe el esperado, el desglose y los montos de los movimientos", async () => {
    await drawerWithCash();
    await signInAs(A.users.reception);
    const blind = await caja.loadCashView();
    expect(blind.ok).toBe(true);
    if (!blind.ok) return;
    expect(blind.data.blindCount).toBe(true);
    expect(blind.data.session).toMatchObject({ expectedMinor: null, expectedLabel: null, breakdown: [] });
    expect(blind.data.session!.movements.length).toBeGreaterThan(0);
    expect(blind.data.session!.movements.every((m) => m.amountLabel === null)).toBe(true);
    expect(blind.data.flaggedSessions).toEqual([]);
    // Nada del esperado viaja en la respuesta, en ningún campo (ni el saldo de apertura), ni en
    // centavos ni como etiqueta.
    const expectedMinor = await ledgerCash(db, A.location);
    const expected = expectedMinor.toString();
    expect(blind.data).toMatchObject({ expectedOpeningMinor: null, expectedOpeningLabel: null });
    const json = JSON.stringify(blind.data);
    expect(json).not.toContain(expected);
    expect(json).not.toContain(format(money(expectedMinor)));
    expect(json).not.toContain(String(expectedMinor / 100n));

    await signInAs(A.users.owner);
    const full = await caja.loadCashView();
    expect(full.ok && full.data.session?.expectedMinor).toBe(expected);
    expect(full.ok && full.data.blindCount).toBe(false);
  });

  it("recepción no puede cerrar sin nota (el error no dice si el conteo cuadra); después ve esperado y diferencia", async () => {
    await cashDrawer(true);
    const units = String((await ledgerCash(db, A.location)) / 100n);
    await signInAs(A.users.reception);
    const before = await fingerprint(A.location);
    const exact = await caja.closeCashSessionAction({ countedUnits: units, idempotencyKey: `cerrar-${uniq()}` });
    const off = await caja.closeCashSessionAction({ countedUnits: "1", idempotencyKey: `cerrar-${uniq()}` });
    // Cuadre o no, la respuesta es la misma: no hay oráculo del esperado.
    expect(off).toEqual(exact);
    expect(exact).toMatchObject({ ok: false, error: expect.stringMatching(/^Escribe una nota del conteo/) });
    expect(await fingerprint(A.location)).toBe(before);
    const closed = await caja.closeCashSessionAction({ countedUnits: units, note: "Todo en orden", idempotencyKey: `cerrar-${uniq()}` });
    expect(closed).toMatchObject({ ok: true, data: { needsReview: false, differenceLabel: expect.any(String), expectedLabel: expect.any(String) } });
  });

  it("el dueño ve los cierres marcados y los da por revisados una sola vez", async () => {
    const id = await flaggedSession();
    await signInAs(A.users.owner);
    const view = await caja.loadCashView();
    expect(view.ok && view.data.flaggedSessions.some((f) => f.id === String(id))).toBe(true);
    expect(await caja.markCashSessionReviewedAction({ sessionId: String(id) })).toMatchObject({ ok: true });
    expect(await caja.markCashSessionReviewedAction({ sessionId: String(id) })).toMatchObject({ ok: false, error: "Ese cierre ya se revisó" });
    const after = await caja.loadCashView();
    expect(after.ok && after.data.flaggedSessions.some((f) => f.id === String(id))).toBe(false);
  });
});

// ─── Verificación en dos pasos: la contraseña sola no basta ──────────────────

describe("con el TOTP activo, la contraseña sola no basta", () => {
  it("códigos de respaldo nuevos: sin código o con uno malo no se llega a generarlos", async () => {
    const owner = await personWithSession("owner", A.location);
    await signInAs(owner);
    state.apiCalls = [];
    expect(await cuenta.regenerateBackupCodesAction({ password: PASSWORD, code: "" })).toMatchObject({ ok: false });
    expect(await cuenta.regenerateBackupCodesAction({ password: PASSWORD, code: "000000" })).toMatchObject({ ok: false, error: "El código no es correcto." });
    expect(await cuenta.regenerateBackupCodesAction({ password: PASSWORD, code: "zzzzz-99999" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/respaldo/),
    });
    expect(await cuenta.regenerateBackupCodesAction({ password: "no-es-la-clave", code: state.totpCode })).toMatchObject({
      ok: false,
      error: "La contraseña no es correcta.",
    });
    expect(state.apiCalls).toEqual([]);
    expect(await cuenta.regenerateBackupCodesAction({ password: PASSWORD, code: state.totpCode })).toEqual({
      ok: true,
      data: { backupCodes: ["nuevo-00001", "nuevo-00002"] },
    });
    expect(state.apiCalls).toEqual(["generateBackupCodes"]);
  });

  it("desactivarla: sin código, con uno malo o con la contraseña mala no se desactiva; con ambos, sí", async () => {
    const owner = await personWithSession("owner", A.location);
    await signInAs(owner);
    state.apiCalls = [];
    expect(await cuenta.disableTwoFactorAction({ password: PASSWORD })).toMatchObject({ ok: false });
    expect(await cuenta.disableTwoFactorAction({ password: PASSWORD, code: "000000" })).toMatchObject({ ok: false, error: "El código no es correcto." });
    expect(await cuenta.disableTwoFactorAction({ password: "no-es-la-clave", code: state.backupCode })).toMatchObject({
      ok: false,
      error: "La contraseña no es correcta.",
    });
    expect(state.apiCalls).toEqual([]);
    expect(await cuenta.disableTwoFactorAction({ password: PASSWORD, code: state.backupCode })).toEqual({ ok: true, data: undefined });
    expect(state.apiCalls).toEqual(["disableTwoFactor"]);
  });

  it("sin TOTP activo no hay nada que desactivar ni regenerar", async () => {
    const barber = await personWithSession("barber", A.location);
    await signInAs(barber);
    state.apiCalls = [];
    for (const run of [cuenta.regenerateBackupCodesAction, cuenta.disableTwoFactorAction]) {
      expect(await run({ password: PASSWORD, code: state.totpCode })).toMatchObject({ ok: false, error: expect.stringMatching(/no tienes/i) });
    }
    expect(state.apiCalls).toEqual([]);
  });

  it("cambiar la contraseña no cuenta como reautenticación si el TOTP está activo", async () => {
    const owner = await personWithSession("owner", A.location);
    await signInAs(owner, { stale: true });
    // Ida y vuelta: la contraseña queda como estaba.
    expect(await cuenta.changeOwnPasswordAction({ currentPassword: PASSWORD, newPassword: TEMP_PASSWORD })).toMatchObject({ ok: true });
    expect(await cuenta.changeOwnPasswordAction({ currentPassword: TEMP_PASSWORD, newPassword: PASSWORD })).toMatchObject({ ok: true });
    const rename = () => personal.updateStaffProfileAction({ staffId: String(owner.staffId), displayName: `Dueña ${uniq()}`, role: "owner", active: true });
    expect(await rename()).toMatchObject({ ok: false, code: "reauth_required" });
    expect(await cuenta.reauthenticateAction({ method: "totp", code: state.totpCode })).toMatchObject({ ok: true });
    expect(await rename()).toMatchObject({ ok: true });
  });
});

// ─── Completitud ─────────────────────────────────────────────────────────────

/** Los módulos "use server" de src/app que cubre la matriz (ruta relativa a src/app). */
const STAFF_MODULES: Record<string, Record<string, unknown>> = {
  "panel/actions.ts": panelRoot,
  "panel/agenda/actions.ts": agenda,
  "panel/servicios/actions.ts": servicios,
  "panel/personal/actions.ts": personal,
  "panel/bloqueos/actions.ts": bloqueos,
  "panel/ajustes/actions.ts": ajustes,
  "panel/cobro/actions.ts": cobro,
  "panel/caja/actions.ts": caja,
  "panel/anulaciones/actions.ts": anulaciones,
  "cuenta/actions.ts": cuenta,
};

/**
 * Públicos a propósito (sin sesión, para quien agenda): sus límites y su aislamiento se prueban en
 * src/app/(publico)/public-endpoints.test.ts. La lista fija obliga a decidir cada endpoint nuevo.
 */
const PUBLIC_MODULES: Record<string, readonly string[]> = {
  "(publico)/actions.ts": [
    "loadDaySummary",
    "loadPublicSlots",
    "startBooking",
    "resendCode",
    "verifyCode",
    "cancelByToken",
    "loadRescheduleDays",
    "loadRescheduleSlots",
    "rescheduleByToken",
  ],
};

const APP_DIR = fileURLToPath(new URL("../", import.meta.url));

/** Todo archivo de src/app con una directiva "use server" (arriba o dentro de una función). */
function serverActionFiles(): string[] {
  return (readdirSync(APP_DIR, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => /^\s*["']use server["'];?\s*$/m.test(readFileSync(join(APP_DIR, f), "utf8")))
    .map((f) => relative(APP_DIR, join(APP_DIR, f)).split("\\").join("/"))
    .sort();
}

describe("guarda de completitud", () => {
  it("todo archivo \"use server\" de src/app está clasificado (personal o público)", () => {
    // Cada export de un archivo "use server" es un endpoint: uno nuevo obliga a decidir quién lo usa.
    expect(serverActionFiles()).toEqual([...Object.keys(STAFF_MODULES), ...Object.keys(PUBLIC_MODULES)].sort());
  });

  it("toda server action del personal está en la matriz de permisos", () => {
    const covered = new Set(CASES.map((c) => c.action));
    const missing = Object.entries(STAFF_MODULES).flatMap(([file, m]) =>
      Object.entries(m)
        .filter(([name, v]) => typeof v === "function" && !covered.has(name))
        .map(([name]) => `${file}: ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it("los endpoints públicos son exactamente los declarados", () => {
    for (const [file, names] of Object.entries(PUBLIC_MODULES)) {
      const source = readFileSync(join(APP_DIR, file), "utf8");
      const exported = [...source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
      expect(exported.sort(), file).toEqual([...names].sort());
    }
  });
});
