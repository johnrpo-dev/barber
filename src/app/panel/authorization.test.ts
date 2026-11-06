import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { changeStatus, createAppointment } from "@/db/appointments";
import { closeBusinessDay, closeCashSession, ledgerCash, openCashSession, openSession as openCash } from "@/db/cash";
import { giveAdvance, previewSettlement, reverseSettlement, settleCommissions } from "@/db/commissions";
import { checkout } from "@/db/sales";
import { decideVoid, requestVoid } from "@/db/voids";
import { createService } from "@/db/catalog";
import { rememberClientDevice } from "@/db/client-devices";
import { findOrCreateClient } from "@/db/clients";
import { recordConsents } from "@/db/consents";
import { createLocation } from "@/db/ledger";
import { saveRecurringExpense } from "@/db/recurring-expenses";
import { auditEvents, cashSessions, expenseCategories, paymentMethods, sales, services, session, staffMembers, twoFactor, user, workerHeartbeats } from "@/db/schema";
import { addStaffMember, createStaffUser, setWeeklySchedule } from "@/db/staff";
import { createTestDb } from "@/db/testing";
import { recordHeartbeat } from "@/db/worker-heartbeat";
import { addTimeOff } from "@/db/time-off";
import type { Db } from "@/db/types";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { format, fromUnits, money } from "@/domain/money";
import type { AuditAction } from "@/domain/audit/events";
import { CSV_REPORTS } from "@/domain/reports/csv";
import type { PaymentKind } from "@/domain/sales/checkout";
import type { Role } from "@/domain/staff/roles";
import { CURRENT_PRIVACY_VERSION } from "@/content/privacy/versions";

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
  // Igual que Next: runAction lo deja pasar y la página responde 404.
  notFound: () => {
    throw Object.assign(new Error("not found"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
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
  // Valor de prueba: con él se cifran los códigos de respaldo que genera la app.
  authSecret: () => "s".repeat(32),
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
const comisiones = await import("./comisiones/actions");
const comprobantes = await import("./comprobantes/actions");
const misComisiones = await import("./mis-comisiones/actions");
const informes = await import("./informes/actions");
const inicio = await import("./inicio/actions");
const auditoria = await import("./auditoria/actions");
const clientes = await import("./clientes/actions");
const ventas = await import("./ventas/actions");
const panelRoot = await import("./actions");
const gastosFijos = await import("./gastos-fijos/actions");

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

/** Una cita de un cliente con 2 faltas (reserva en línea suspendida). */
async function suspendedClientAppointment(): Promise<string> {
  const c = await findOrCreateClient(db, { locationId: A.location, name: `Cliente ${uniq()}`, phone: `31${uniq()}` });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { date, minute } = nextSlot();
    const created = await createAppointment(db, {
      locationId: A.location,
      serviceId: A.service,
      staffId: A.users.barber.staffId,
      start: localMinuteToInstant(date, minute, TZ),
      clientId: c.id,
      source: "staff",
      idempotencyKey: `seed-${uniq()}`,
      createdBy: "seed",
    });
    ids.push(String(created.appointmentId));
  }
  await client.query(`update appointments set status = 'no_show' where id = any($1::bigint[])`, [ids]);
  return ids[0]!;
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

async function salePublicId(saleId: bigint): Promise<string> {
  const [row] = await db.select({ publicId: sales.publicId }).from(sales).where(eq(sales.id, saleId));
  return row!.publicId;
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

/** Cortesías (sprint 8): el tope de descuento de la sede en 100 % y si recepción puede dar descuentos. */
async function courtesyRules(locationId: bigint, opts: { maxDiscountBps?: number; receptionCanDiscount?: boolean } = {}): Promise<void> {
  await client.query(`update locations set max_discount_bps = $2, reception_can_discount = $3 where id = $1`, [
    String(locationId),
    opts.maxDiscountBps ?? 10_000,
    opts.receptionCanDiscount ?? false,
  ]);
}

// ─── Gastos fijos (sprint 8): estado de partida para cada intento ───────────

/** Primer día del mes de hoy (el periodo que ya toca) y un día de pago que ya venció o vence hoy. */
const thisPeriod = () => `${businessDate(new Date(), TZ).slice(0, 7)}-01`;
const dueDay = () => Math.min(Number(businessDate(new Date(), TZ).slice(8, 10)), 28);

/** Una plantilla de la sede A (por defecto) cuyo periodo de este mes ya toca. */
async function seedRecurring(payMode: "cash" | "bank", opts: { locationId?: bigint; categoryId?: bigint; startMonth?: string } = {}): Promise<string> {
  const { id } = await saveRecurringExpense(db, {
    locationId: opts.locationId ?? A.location,
    categoryId: opts.categoryId ?? A.category,
    draft: {
      name: `Gasto fijo ${uniq()}`,
      estimatedAmount: fromUnits(payMode === "cash" ? 5_000n : 800_000n),
      payMode,
      dayOfMonth: dueDay(),
      intervalMonths: 1,
      startMonth: opts.startMonth ?? thisPeriod(),
      active: true,
    },
    actor: { userId: "seed" },
  });
  return id.toString();
}

const recurringDraft = (over: Record<string, unknown> = {}) => ({
  name: `Internet ${uniq()}`,
  categoryId: String(A.category),
  estimatedUnits: "120000",
  payMode: "bank" as const,
  dayOfMonth: 10,
  intervalMonths: 1,
  startMonth: thisPeriod(),
  active: true,
  ...over,
});

// ─── Comisiones: estado de partida para cada intento ────────────────────────

/** La entrada de una liquidación por banco de lo pendiente del barbero de la sede A. */
function settlementInput(staffId = A.users.barber.staffId) {
  return {
    staffId: String(staffId),
    cutoffDate: businessDate(new Date(), TZ),
    includeTips: true,
    adjustments: [],
    paidFrom: "bank" as const,
  };
}

const settlementOptions = () => ({
  locationId: A.location,
  staffId: A.users.barber.staffId,
  cutoffDate: businessDate(new Date(), TZ),
  includeTips: true,
  advanceDeduction: "max" as const,
  adjustments: [],
  paidFrom: "bank" as const,
  note: null,
});

/** Algo por liquidar y su token de vista previa. */
async function pendingSettlement(): Promise<string> {
  await seedSale();
  return (await previewSettlement(db, settlementOptions())).previewToken;
}

/** Una liquidación ya hecha del barbero de la sede A (la última, así que se puede revertir). */
async function seedSettlement(): Promise<string> {
  const previewToken = await pendingSettlement();
  const done = await settleCommissions(db, { ...settlementOptions(), previewToken, idempotencyKey: `seed-settle-${uniq()}`, actor: SEED_ACTOR() });
  return done.publicId;
}

/** Un anticipo por banco del barbero de la sede A. */
/** Un cliente sin citas, solo para suprimirlo. */
async function seedClient(): Promise<string> {
  const c = await findOrCreateClient(db, { locationId: A.location, name: `Cliente ${uniq()}`, phone: `31${uniq()}` });
  return c.id.toString();
}

/** Un cliente con el recordatorio y las promociones autorizados en línea (ficha, sprint 7). */
async function clientWithConsents(): Promise<string> {
  const id = await seedClient();
  await recordConsents(db, {
    locationId: A.location,
    clientId: BigInt(id),
    appointmentId: null,
    choices: { dataProcessing: true, reminders: true, marketing: true },
    textVersion: CURRENT_PRIVACY_VERSION,
    ip: null,
    userAgent: null,
    source: "online",
  });
  return id;
}

/** Un cliente con dos navegadores recordados. */
async function clientWithDevices(): Promise<string> {
  const id = await seedClient();
  for (let i = 0; i < 2; i++) await rememberClientDevice(db, { locationId: A.location, clientId: BigInt(id), now: new Date() });
  return id;
}

/** Un cliente con 2 faltas (reserva en línea suspendida), por su id. */
async function suspendedClient(): Promise<string> {
  const appointmentId = await suspendedClientAppointment();
  const { rows } = await client.query<{ id: string }>(`select client_id::text as id from appointments where id = $1`, [appointmentId]);
  return rows[0]!.id;
}

async function seedAdvance(): Promise<string> {
  const done = await giveAdvance(db, {
    locationId: A.location,
    staffId: A.users.barber.staffId,
    amount: fromUnits(1_000n),
    paidFrom: "bank",
    reason: "Adelanto de prueba",
    idempotencyKey: `seed-adv-${uniq()}`,
    actor: SEED_ACTOR(),
  });
  return done.publicId;
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
  if (role === "owner") await enableTotp(userId);
  return { id: userId, staffId, sessionId: await openSession(userId) };
}

/** TOTP activo, como queda tras inscribirse (la fila de two_factor la escriben ahora también las acciones de cuenta). */
async function enableTotp(userId: string): Promise<void> {
  await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, userId));
  await db.delete(twoFactor).where(eq(twoFactor.userId, userId));
  await db.insert(twoFactor).values({ id: randomUUID(), secret: "secreto-de-prueba", backupCodes: "codigos-de-prueba", userId, verified: true });
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
      (select coalesce(string_agg(id || ':' || coalesce(no_shows_cleared_at::text, '-'), ',' order by id), '')
         from clients where ${loc}::bigint is null or location_id = ${loc}) as clients_cleared,
      (select count(*) from client_consents where ${loc}::bigint is null or location_id = ${loc}) as consents,
      (select coalesce(string_agg(id || ':' || (revoked_at is null), ',' order by id), '')
         from client_devices where ${loc}::bigint is null or location_id = ${loc}) as devices,
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
         from commission_settlements where ${loc}::bigint is null or location_id = ${loc}) as settlements,
      (select coalesce(string_agg(id || ':' || reversed, ',' order by id), '')
         from commission_settlement_lines where ${loc}::bigint is null or location_id = ${loc}) as settlement_lines,
      (select coalesce(string_agg(id || ':' || status, ',' order by id), '')
         from staff_advances where ${loc}::bigint is null or location_id = ${loc}) as advances,
      (select count(*) from audit_events where ${loc}::bigint is null or location_id = ${loc}) as audit,
      (select coalesce(string_agg(id || ':' || status, ',' order by id), '')
         from void_requests where ${loc}::bigint is null or location_id = ${loc}) as void_requests,
      (select coalesce(string_agg(id || ':' || label || ':' || fee_bps || ':' || active, ',' order by id), '')
         from payment_methods where ${loc}::bigint is null or location_id = ${loc}) as payment_methods,
      (select coalesce(string_agg(id || ':' || name || ':' || account_code || ':' || active, ',' order by id), '')
         from expense_categories where ${loc}::bigint is null or location_id = ${loc}) as expense_categories,
      (select count(*) from appointment_courtesies where ${loc}::bigint is null or location_id = ${loc}) as courtesies,
      (select coalesce(string_agg(id || ':' || name || ':' || category_id || ':' || estimated_amount || ':' || pay_mode || ':' || day_of_month
                || ':' || interval_months || ':' || start_month || ':' || active, ',' order by id), '')
         from recurring_expenses where ${loc}::bigint is null or location_id = ${loc}) as recurring_expenses,
      (select count(*) from recurring_expense_runs where ${loc}::bigint is null or location_id = ${loc}) as recurring_runs
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
    name: "clientes · vista previa de la supresión",
    action: "loadClientErasePreview",
    allowed: ["owner"],
    prepare: async () => {
      const clientId = await seedClient();
      return () => clientes.loadClientErasePreview({ clientId });
    },
  },
  {
    name: "clientes · suprimir los datos",
    action: "eraseClientAction",
    allowed: ["owner"],
    prepare: async () => {
      const clientId = await seedClient();
      return () => clientes.eraseClientAction({ clientId, confirmation: "SUPRIMIR" });
    },
  },
  {
    name: "clientes · buscar para abrir la ficha",
    action: "loadClientSearch",
    allowed: ["owner", "reception"],
    prepare: async () => () => clientes.loadClientSearch("Juan"),
  },
  {
    name: "clientes · ver la ficha",
    action: "loadClientRecord",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const clientId = await clientWithDevices();
      return () => clientes.loadClientRecord({ clientId });
    },
  },
  {
    name: "clientes · retirar el recordatorio",
    action: "withdrawConsentAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const clientId = await clientWithConsents();
      return () => clientes.withdrawConsentAction({ clientId, purpose: "reminders" });
    },
  },
  {
    name: "clientes · retirar las promociones",
    action: "withdrawConsentAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const clientId = await clientWithConsents();
      return () => clientes.withdrawConsentAction({ clientId, purpose: "marketing" });
    },
  },
  {
    name: "clientes · olvidar los navegadores",
    action: "forgetClientDevicesAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const clientId = await clientWithDevices();
      return () => clientes.forgetClientDevicesAction({ clientId });
    },
  },
  {
    name: "clientes · desbloquear la reserva en línea desde la ficha",
    action: "clearClientNoShowsAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const clientId = await suspendedClient();
      return () => clientes.clearClientNoShowsAction({ clientId });
    },
  },
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
    name: "agenda · desbloquear la reserva en línea de un cliente con faltas",
    action: "clearNoShowsAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const id = await suspendedClientAppointment();
      return () => agenda.clearNoShowsAction({ appointmentId: id });
    },
  },
  {
    name: "agenda · marcar que otro barbero salió o llegó",
    action: "setPresenceAction",
    allowed: ["owner", "reception"],
    prepare: async () => () => agenda.setPresenceAction({ staffId: String(A.dummy), kind: "out" }),
  },
  {
    name: "agenda · marcar que uno mismo salió",
    action: "setPresenceAction",
    allowed: ["owner", "reception", "barber"],
    prepare: async () => () => agenda.setPresenceAction({ staffId: String(myStaffId()), kind: "out" }),
  },
  {
    name: "agenda · fila del walk-in",
    action: "loadWalkInQueue",
    allowed: ["owner", "reception"],
    prepare: async () => () => agenda.loadWalkInQueue({ serviceId: String(A.service) }),
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
    name: "personal · servicios que hace",
    action: "saveStaffServicesAction",
    allowed: ["owner"],
    prepare: async () => {
      const target = await addStaffMember(db, { locationId: A.location, displayName: `Manicurista ${uniq()}`, role: "barber" });
      // Nace con todos los servicios: quitárselos es un cambio y deja un evento.
      return () => personal.saveStaffServicesAction({ staffId: String(target), serviceIds: [] });
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
          walkInGuardMin: 60,
          noShowLimit: 2,
          bookingRequiresCode: false,
          taxId: "900.123.456-7",
          receiptFooter: `Gracias ${n}`,
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
    // Desactiva de verdad en la base: se vuelve a activar para no dejar sin TOTP al dueño compartido.
    prepare: async () => async () => {
      const result = await cuenta.disableTwoFactorAction({ password: PASSWORD, code: state.totpCode });
      if (result.ok && state.session) await enableTotp(state.session.user.id);
      return result;
    },
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
    // Sprint 8: quien puede dar descuentos y solo con el tope en 100 %. Recepción, solo si la sede lo
    // habilita (por defecto no): se prueba aparte en "cortesías".
    name: "caja · dar una cita como cortesía",
    action: "giveCourtesyAction",
    allowed: ["owner"],
    prepare: async () => {
      await courtesyRules(A.location);
      const appointmentId = await chairAppointment();
      return () => caja.giveCourtesyAction({ appointmentId: String(appointmentId), reason: "Cumpleaños del cliente" });
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

  // ─── Comisiones, comprobantes, informes, tablero y bitácora (sprint 5) ──
  {
    name: "comisiones · resumen de todos",
    action: "loadCommissionsOverview",
    allowed: ["owner"],
    prepare: async () => () => comisiones.loadCommissionsOverview(),
  },
  {
    name: "comisiones · detalle de una persona",
    action: "loadStaffCommissions",
    allowed: ["owner"],
    prepare: async () => () => comisiones.loadStaffCommissions({ staffId: String(A.users.barber.staffId) }),
  },
  {
    name: "comisiones · vista previa",
    action: "loadSettlementPreview",
    allowed: ["owner"],
    prepare: async () => {
      await seedSale();
      return () => comisiones.loadSettlementPreview(settlementInput());
    },
  },
  {
    name: "comisiones · liquidar",
    action: "settleCommissionsAction",
    allowed: ["owner"],
    prepare: async () => {
      const previewToken = await pendingSettlement();
      return () => comisiones.settleCommissionsAction({ ...settlementInput(), previewToken, idempotencyKey: `settle-${uniq()}` });
    },
  },
  {
    name: "comisiones · revertir una liquidación",
    action: "reverseSettlementAction",
    allowed: ["owner"],
    prepare: async () => {
      const publicId = await seedSettlement();
      return () => comisiones.reverseSettlementAction({ publicId, reason: "Se liquidó de más", idempotencyKey: `undo-${uniq()}` });
    },
  },
  {
    name: "comisiones · dar un anticipo",
    action: "giveAdvanceAction",
    allowed: ["owner"],
    prepare: async () => () =>
      comisiones.giveAdvanceAction({
        staffId: String(A.users.barber.staffId),
        amountUnits: "1000",
        paidFrom: "bank",
        reason: "Adelanto",
        idempotencyKey: `adv-${uniq()}`,
      }),
  },
  {
    name: "comisiones · revertir un anticipo",
    action: "reverseAdvanceAction",
    allowed: ["owner"],
    prepare: async () => {
      const publicId = await seedAdvance();
      return () => comisiones.reverseAdvanceAction({ publicId, reason: "No se entregó", idempotencyKey: `undo-${uniq()}` });
    },
  },
  {
    name: "comprobantes · el comprobante propio",
    action: "loadReceipt",
    allowed: ["owner", "barber"],
    prepare: async () => {
      const publicId = await seedSettlement();
      return () => comprobantes.loadReceipt({ publicId });
    },
  },
  {
    name: "ventas · recibo de una venta de hoy",
    action: "loadSaleReceipt",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const publicId = await salePublicId(await seedSale());
      return () => ventas.loadSaleReceipt({ publicId });
    },
  },
  {
    name: "ventas · las del día",
    action: "loadSalesOfDay",
    allowed: ["owner", "reception"],
    prepare: async () => () => ventas.loadSalesOfDay({}),
  },
  {
    name: "ventas · historial por día",
    action: "loadSalesHistory",
    allowed: ["owner"],
    prepare: async () => () => ventas.loadSalesHistory({}),
  },
  {
    name: "caja · historial de aperturas y cierres",
    action: "loadCashHistory",
    allowed: ["owner"],
    prepare: async () => () => caja.loadCashHistory({}),
  },
  {
    name: "mis comisiones",
    action: "loadMyCommissions",
    allowed: ["owner", "barber"],
    prepare: async () => () => misComisiones.loadMyCommissions(),
  },
  {
    name: "informes · ver",
    action: "loadReport",
    allowed: ["owner"],
    prepare: async () => {
      const day = businessDate(new Date(), TZ);
      return () => informes.loadReport({ from: day, to: day });
    },
  },
  {
    name: "informes · exportar",
    action: "exportReportCsvAction",
    allowed: ["owner"],
    prepare: async () => {
      const day = businessDate(new Date(), TZ);
      return () => informes.exportReportCsvAction({ report: "journal", from: day, to: day });
    },
  },
  {
    name: "informes · exportar el historial de ventas",
    action: "exportReportCsvAction",
    allowed: ["owner"],
    prepare: async () => {
      const day = businessDate(new Date(), TZ);
      return () => informes.exportReportCsvAction({ report: "sales", from: day, to: day });
    },
  },
  {
    name: "informes · exportar el historial de caja",
    action: "exportReportCsvAction",
    allowed: ["owner"],
    prepare: async () => {
      const day = businessDate(new Date(), TZ);
      return () => informes.exportReportCsvAction({ report: "cash_sessions", from: day, to: day });
    },
  },
  {
    name: "gastos fijos · ver",
    action: "loadRecurringExpenses",
    allowed: ["owner"],
    prepare: async () => () => gastosFijos.loadRecurringExpenses(),
  },
  {
    name: "gastos fijos · crear una plantilla",
    action: "saveRecurringExpenseAction",
    allowed: ["owner"],
    prepare: async () => () => gastosFijos.saveRecurringExpenseAction(recurringDraft()),
  },
  {
    name: "gastos fijos · editar una plantilla",
    action: "saveRecurringExpenseAction",
    allowed: ["owner"],
    prepare: async () => {
      const id = await seedRecurring("bank");
      return () => gastosFijos.saveRecurringExpenseAction(recurringDraft({ id, estimatedUnits: "850000" }));
    },
  },
  {
    name: "gastos fijos · registrar uno de caja",
    action: "registerRecurringExpenseAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      await drawerWithCash();
      const recurringId = await seedRecurring("cash");
      return () => gastosFijos.registerRecurringExpenseAction({ recurringId, period: thisPeriod(), amountUnits: "5000", description: "Aseo del mes" });
    },
  },
  {
    name: "gastos fijos · registrar uno de banco",
    action: "registerRecurringExpenseAction",
    allowed: ["owner"],
    prepare: async () => {
      const recurringId = await seedRecurring("bank");
      return () => gastosFijos.registerRecurringExpenseAction({ recurringId, period: thisPeriod(), amountUnits: "812000", description: "Arriendo del mes" });
    },
  },
  {
    name: "gastos fijos · omitir un periodo",
    action: "skipRecurringExpenseAction",
    allowed: ["owner"],
    prepare: async () => {
      const recurringId = await seedRecurring("bank");
      return () => gastosFijos.skipRecurringExpenseAction({ recurringId, period: thisPeriod(), reason: "Se pagó junto con el mes anterior" });
    },
  },
  {
    name: "tablero del dueño",
    action: "loadDashboard",
    allowed: ["owner"],
    prepare: async () => () => inicio.loadDashboard(),
  },
  {
    name: "bitácora de auditoría",
    action: "loadAuditLog",
    allowed: ["owner"],
    prepare: async () => () => auditoria.loadAuditLog({}),
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
    name: "registrar un gasto fijo de esta sede",
    prepare: async () => {
      const recurringId = await seedRecurring("bank");
      return () => gastosFijos.registerRecurringExpenseAction({ recurringId, period: thisPeriod(), amountUnits: "1000", description: "Intruso" });
    },
  },
  {
    name: "omitir un gasto fijo de esta sede",
    prepare: async () => {
      const recurringId = await seedRecurring("bank");
      return () => gastosFijos.skipRecurringExpenseAction({ recurringId, period: thisPeriod(), reason: "Intruso de otra sede" });
    },
  },
  {
    name: "editar un gasto fijo de esta sede",
    prepare: async () => {
      const id = await seedRecurring("bank");
      return () => gastosFijos.saveRecurringExpenseAction(recurringDraft({ id, name: "Hackeado", active: false }));
    },
  },
  {
    name: "crear un gasto fijo con una categoría de esta sede",
    prepare: async () => () => gastosFijos.saveRecurringExpenseAction(recurringDraft()),
  },
  {
    name: "dar como cortesía una cita de esta sede",
    prepare: async () => {
      await courtesyRules(A.location);
      await courtesyRules(B.location);
      const appointmentId = await chairAppointment();
      return () => caja.giveCourtesyAction({ appointmentId: String(appointmentId), reason: "Intruso" });
    },
  },
  {
    name: "ver la ficha de un cliente",
    prepare: async () => {
      const clientId = await clientWithDevices();
      return () => clientes.loadClientRecord({ clientId });
    },
  },
  {
    name: "retirar una autorización de un cliente",
    prepare: async () => {
      const clientId = await clientWithConsents();
      return () => clientes.withdrawConsentAction({ clientId, purpose: "marketing" });
    },
  },
  {
    name: "olvidar los navegadores de un cliente",
    prepare: async () => {
      const clientId = await clientWithDevices();
      return () => clientes.forgetClientDevicesAction({ clientId });
    },
  },
  {
    name: "desbloquear la reserva en línea de un cliente",
    prepare: async () => {
      const clientId = await suspendedClient();
      return () => clientes.clearClientNoShowsAction({ clientId });
    },
  },
  {
    name: "suprimir los datos de un cliente",
    prepare: async () => {
      const clientId = await seedClient();
      return () => clientes.eraseClientAction({ clientId, confirmation: "SUPRIMIR" });
    },
  },
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
    name: "quitarle los servicios a alguien",
    prepare: async () => () => personal.saveStaffServicesAction({ staffId: String(A.users.barber.staffId), serviceIds: [] }),
  },
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
  {
    name: "ver las comisiones de una persona",
    prepare: async () => () => comisiones.loadStaffCommissions({ staffId: String(A.users.barber.staffId) }),
  },
  {
    name: "abrir la vista previa de una liquidación",
    prepare: async () => {
      await seedSale();
      return () => comisiones.loadSettlementPreview(settlementInput());
    },
  },
  {
    name: "liquidar a una persona",
    prepare: async () => {
      const previewToken = await pendingSettlement();
      return () => comisiones.settleCommissionsAction({ ...settlementInput(), previewToken, idempotencyKey: `settle-${uniq()}` });
    },
  },
  {
    name: "revertir una liquidación",
    prepare: async () => {
      const publicId = await seedSettlement();
      return () => comisiones.reverseSettlementAction({ publicId, reason: "Se liquidó de más", idempotencyKey: `undo-${uniq()}` });
    },
  },
  {
    name: "dar un anticipo",
    prepare: async () => () =>
      comisiones.giveAdvanceAction({ staffId: String(A.users.barber.staffId), amountUnits: "1000", paidFrom: "bank", reason: "Adelanto", idempotencyKey: `adv-${uniq()}` }),
  },
  {
    name: "revertir un anticipo",
    prepare: async () => {
      const publicId = await seedAdvance();
      return () => comisiones.reverseAdvanceAction({ publicId, reason: "No se entregó", idempotencyKey: `undo-${uniq()}` });
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

describe("suprimir datos de un cliente", () => {
  it("con una sesión vieja pide confirmar identidad y sin escribir SUPRIMIR no hace nada", async () => {
    const clientId = await seedClient();
    await signInAs(A.users.owner, { stale: true });
    expect(await clientes.eraseClientAction({ clientId, confirmation: "SUPRIMIR" })).toMatchObject({ ok: false, code: "reauth_required" });
    await signInAs(A.users.owner);
    expect(await clientes.eraseClientAction({ clientId, confirmation: "si" as never })).toMatchObject({ ok: false });
    const { rows } = await client.query<{ name: string }>(`select name from clients where id = $1`, [clientId]);
    expect(rows[0]!.name).not.toBe("Anónimo");
  });

  it("el evento no lleva el nombre ni el celular", async () => {
    const clientId = await seedClient();
    const { rows: before } = await client.query<{ name: string; phone: string }>(`select name, phone_e164 as phone from clients where id = $1`, [clientId]);
    await signInAs(A.users.owner);
    expect(await clientes.eraseClientAction({ clientId, confirmation: "SUPRIMIR" })).toMatchObject({ ok: true });
    const { rows } = await client.query<{ row: string; target: string }>(`select row(a.*)::text as row, target_ref as target from audit_events a where action = 'client.erase' order by id desc limit 1`);
    expect(rows[0]!.target).toBe(clientId);
    expect(rows[0]!.row).not.toContain(before[0]!.name);
    expect(rows[0]!.row).not.toContain(before[0]!.phone);
  });
});

describe("ficha del cliente (sprint 7)", () => {
  it("retirar el recordatorio inserta una fila nueva del personal con la versión vigente; el evento no lleva datos de la persona", async () => {
    const clientId = await clientWithConsents();
    const { rows: who } = await client.query<{ name: string; phone: string }>(`select name, phone_e164 as phone from clients where id = $1`, [clientId]);
    await signInAs(A.users.reception);
    expect(await clientes.withdrawConsentAction({ clientId, purpose: "reminders" })).toMatchObject({ ok: true });
    const { rows } = await client.query<{ purpose: string; granted: boolean; version: string; source: string }>(
      `select purpose, granted, text_version as version, source from client_consents where client_id = $1 order by id`,
      [clientId],
    );
    expect(rows).toHaveLength(4); // las tres de la reserva + el retiro; nada se editó
    expect(rows.at(-1)).toEqual({ purpose: "reminders", granted: false, version: CURRENT_PRIVACY_VERSION, source: "staff" });
    const { rows: events } = await client.query<{ row: string; target: string }>(
      `select row(a.*)::text as row, target_ref as target from audit_events a where action = 'client.consent_withdraw' order by id desc limit 1`,
    );
    expect(events[0]!.target).toBe(clientId);
    expect(events[0]!.row).toContain("recordatorio");
    expect(events[0]!.row).not.toContain(who[0]!.name);
    expect(events[0]!.row).not.toContain(who[0]!.phone);
    // Ya retirada: la segunda vez no escribe nada.
    const before = await fingerprint();
    expect(await clientes.withdrawConsentAction({ clientId, purpose: "reminders" })).toMatchObject({ ok: false });
    expect(await fingerprint()).toBe(before);
  });

  it("el tratamiento de datos no se retira desde la ficha (eso es la supresión)", async () => {
    const clientId = await clientWithConsents();
    await signInAs(A.users.owner);
    const before = await fingerprint();
    expect(await clientes.withdrawConsentAction({ clientId, purpose: "data_processing" as never })).toMatchObject({ ok: false });
    expect(await fingerprint()).toBe(before);
  });

  it("olvidar los navegadores revoca todos los activos; sin navegadores, no hace nada", async () => {
    const clientId = await clientWithDevices();
    await signInAs(A.users.reception);
    expect(await clientes.forgetClientDevicesAction({ clientId })).toEqual({ ok: true, data: { forgotten: 2 } });
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from client_devices where client_id = $1 and revoked_at is null`, [clientId]);
    expect(rows[0]!.n).toBe(0);
    const before = await fingerprint();
    expect(await clientes.forgetClientDevicesAction({ clientId })).toMatchObject({ ok: false });
    expect(await fingerprint()).toBe(before);
  });

  it("la ficha trae historial, faltas, autorizaciones y navegadores; deja constancia de quién vio el celular", async () => {
    const clientId = await clientWithConsents();
    await rememberClientDevice(db, { locationId: A.location, clientId: BigInt(clientId), now: new Date() });
    await signInAs(A.users.reception);
    const r = await clientes.loadClientRecord({ clientId });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.phone).toMatch(/^3\d{2} \d{3} \d{4}$/);
    expect(r.data.devices.active).toBe(1);
    expect(r.data.consents.map((c) => [c.purpose, c.granted, c.withdrawable])).toEqual([
      ["data_processing", true, false],
      ["reminders", true, true],
      ["marketing", true, true],
    ]);
    expect(r.data.consents[0]!.version).toBe(CURRENT_PRIVACY_VERSION);
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from personal_data_reads where staff_id = $1 and $2::bigint = any(client_ids)`,
      [String(A.users.reception.staffId), clientId],
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it("la búsqueda trae hasta 8 y avisa si hay más; solo deja constancia de los que se muestran", async () => {
    const tag = uniq().replace(/d/g, (d) => "abcdefghij"[Number(d)]!);
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push((await findOrCreateClient(db, { locationId: A.location, name: `Afinar ${tag} ${i}`, phone: `31${uniq()}` })).id.toString());
    await signInAs(A.users.reception);
    const r = await clientes.loadClientSearch(`Afinar ${tag}`);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.clients).toHaveLength(8);
    expect(r.data.hasMore).toBe(true);
    const shown = r.data.clients.map((c) => c.id);
    const hidden = ids.filter((id) => !shown.includes(id));
    expect(hidden).toHaveLength(1);
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from personal_data_reads where staff_id = $1 and $2::bigint = any(client_ids)`,
      [String(A.users.reception.staffId), hidden[0]!],
    );
    expect(rows[0]!.n).toBe(0);
    const narrowed = await clientes.loadClientSearch(`Afinar ${tag} 3`);
    if (!narrowed.ok) throw new Error(narrowed.error);
    expect(narrowed.data).toEqual({ clients: [expect.objectContaining({ id: ids[3] })], hasMore: false });
  });

  it("un cliente suprimido ya no tiene ficha", async () => {
    const clientId = await seedClient();
    await signInAs(A.users.owner);
    expect(await clientes.eraseClientAction({ clientId, confirmation: "SUPRIMIR" })).toMatchObject({ ok: true });
    expect(await clientes.loadClientRecord({ clientId })).toMatchObject({ ok: false });
  });
});

describe("conteo a ciegas", () => {
  it("recepción no ve el monto de una liquidación ni de un anticipo pagados de la caja", async () => {
    await drawerWithCash();
    await drawerWithCash();
    await giveAdvance(db, {
      locationId: A.location,
      staffId: A.users.barber.staffId,
      amount: fromUnits(1_000n),
      paidFrom: "cash",
      reason: "Adelanto de prueba",
      idempotencyKey: `seed-adv-${uniq()}`,
      actor: SEED_ACTOR(),
    });
    const options = { ...settlementOptions(), paidFrom: "cash" as const, advanceDeduction: fromUnits(0n) };
    const { previewToken } = await previewSettlement(db, options);
    await settleCommissions(db, { ...options, previewToken, idempotencyKey: `seed-settle-${uniq()}`, actor: SEED_ACTOR() });

    await signInAs(A.users.reception);
    const blind = await caja.loadCashView();
    if (!blind.ok) throw new Error(blind.error);
    const movements = blind.data.session!.movements;
    expect(movements.some((m) => m.kind === "commission_payout")).toBe(true);
    expect(movements.some((m) => m.kind === "staff_advance")).toBe(true);
    expect(movements.every((m) => m.amountLabel === null)).toBe(true);
  });

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

  it("recepción abre y cierra la caja, y el historial de ventas del día registra quién lo hizo", async () => {
    await cashDrawer(false);
    const units = String((await ledgerCash(db, A.location)) / 100n);
    await signInAs(A.users.reception);
    expect(await caja.openCashSessionAction({ countedUnits: units, idempotencyKey: `abrir-${uniq()}` })).toMatchObject({ ok: true });
    expect(await caja.closeCashSessionAction({ countedUnits: units, note: "Fin del turno", idempotencyKey: `cerrar-${uniq()}` })).toMatchObject({ ok: true });

    await signInAs(A.users.owner);
    const history = await ventas.loadSalesHistory({});
    expect(history.ok).toBe(true);
    const today = history.ok ? history.data.days.find((d) => d.date === businessDate(new Date(), TZ)) : undefined;
    expect(today?.shifts).toContainEqual({
      openedBy: expect.stringMatching(/^Persona reception/),
      openedTime: expect.stringMatching(/^\d{2}:\d{2}$/),
      closedBy: expect.stringMatching(/^Persona reception/),
      closedLabel: expect.stringMatching(/^\d{2}:\d{2}$/),
    });
  });

  it("recepción abre a ciegas: no recibe el saldo esperado y, sin nota, queda la de conteo a ciegas", async () => {
    await cashDrawer(false);
    const expectedMinor = await ledgerCash(db, A.location);
    await signInAs(A.users.reception);
    const blind = await caja.loadCashView();
    expect(blind.ok && blind.data).toMatchObject({ session: null, expectedOpeningMinor: null, expectedOpeningLabel: null });
    const counted = String(expectedMinor / 100n + 1n);
    expect(await caja.openCashSessionAction({ countedUnits: counted, idempotencyKey: `abrir-${uniq()}` })).toMatchObject({ ok: true });
    const [opened] = await db.select({ note: cashSessions.openingNote }).from(cashSessions).where(eq(cashSessions.locationId, A.location)).orderBy(sql`${cashSessions.id} desc`).limit(1);
    expect(opened?.note).toBe("Conteo a ciegas al abrir");
    expect(await caja.closeCashSessionAction({ countedUnits: counted, note: "Fin", idempotencyKey: `cerrar-${uniq()}` })).toMatchObject({ ok: true });

    await signInAs(A.users.owner);
    const full = await caja.loadCashView();
    expect(full.ok && full.data.expectedOpeningMinor).not.toBeNull();
  });

  it("con el día de hoy cerrado, recepción abre la caja igual: el día se reabre a su nombre (y el barbero no puede)", async () => {
    await cashDrawer(false);
    const day = businessDate(new Date(), TZ);
    await closeBusinessDay(db, { locationId: A.location, businessDate: day, actor: { userId: "seed" } });
    const units = String((await ledgerCash(db, A.location)) / 100n);

    await signInAs(A.users.reception);
    const view = await caja.loadCashView();
    expect(view.ok && view.data).toMatchObject({ dayClosed: true, canReopenToday: true, canReopenDay: false });
    expect(await caja.openCashSessionAction({ countedUnits: units, idempotencyKey: `abrir-${uniq()}` })).toMatchObject({ ok: true });
    const after = await caja.loadCashView();
    expect(after.ok && after.data).toMatchObject({ dayClosed: false, todayReopened: { by: expect.stringMatching(/^Persona reception/) } });

    // Quien no maneja caja no la abre, ni con el día cerrado.
    await signInAs(A.users.reception);
    expect(await caja.closeCashSessionAction({ countedUnits: units, note: "Fin", idempotencyKey: `cerrar-${uniq()}` })).toMatchObject({ ok: true });
    await signInAs(A.users.barber);
    await expect(caja.openCashSessionAction({ countedUnits: units, idempotencyKey: `abrir-${uniq()}` })).rejects.toMatchObject({ url: "/panel?sin-permiso=1" });
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
    const events = async () => (await db.select({ id: auditEvents.id }).from(auditEvents).where(sql`${auditEvents.actorUserId} = ${owner.id} and ${auditEvents.action} = 'account.backup_codes'`)).length;
    const [before] = await db.select({ codes: twoFactor.backupCodes }).from(twoFactor).where(eq(twoFactor.userId, owner.id));
    expect(await events()).toBe(0);
    const r = await cuenta.regenerateBackupCodesAction({ password: PASSWORD, code: state.totpCode });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const codes = (r as { ok: true; data: { backupCodes: string[] } }).data.backupCodes;
    expect(codes).toHaveLength(10);
    expect(codes.every((c) => /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(c))).toBe(true);
    // Los códigos y su evento, juntos (L11); nada pasa por la API de better-auth.
    const [after] = await db.select({ codes: twoFactor.backupCodes }).from(twoFactor).where(eq(twoFactor.userId, owner.id));
    expect(after!.codes).not.toBe(before!.codes);
    expect(await events()).toBe(1);
    expect(state.apiCalls).toEqual([]);
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
    const [u] = await db.select({ on: user.twoFactorEnabled }).from(user).where(eq(user.id, owner.id));
    expect(u?.on).toBe(false);
    expect(await db.select().from(twoFactor).where(eq(twoFactor.userId, owner.id))).toHaveLength(0);
    const events = await db.select({ id: auditEvents.id }).from(auditEvents).where(sql`${auditEvents.actorUserId} = ${owner.id} and ${auditEvents.action} = 'account.two_factor_disable'`);
    expect(events).toHaveLength(1);
    expect(state.apiCalls).toEqual([]);
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
  "panel/clientes/actions.ts": clientes,
  "panel/comisiones/actions.ts": comisiones,
  "panel/comprobantes/actions.ts": comprobantes,
  "panel/mis-comisiones/actions.ts": misComisiones,
  "panel/informes/actions.ts": informes,
  "panel/inicio/actions.ts": inicio,
  "panel/auditoria/actions.ts": auditoria,
  "panel/agenda/actions.ts": agenda,
  "panel/servicios/actions.ts": servicios,
  "panel/personal/actions.ts": personal,
  "panel/bloqueos/actions.ts": bloqueos,
  "panel/ajustes/actions.ts": ajustes,
  "panel/cobro/actions.ts": cobro,
  "panel/caja/actions.ts": caja,
  "panel/gastos-fijos/actions.ts": gastosFijos,
  "panel/anulaciones/actions.ts": anulaciones,
  "panel/ventas/actions.ts": ventas,
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
    "bookAsKnown",
    "forgetDevice",
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

// ─── Auditoría de lecturas de contactos (Ley 1581, sprint 5) ─────────────────

describe("auditoría de lecturas de contactos", () => {
  it("buscar clientes con el celular completo deja constancia de quién los vio; recargar no la repite", async () => {
    const reads = async () =>
      (
        await client.query<{ staff: string; context: string; clients: string }>(
          `select staff_id::text as staff, context, array_to_string(client_ids, ',') as clients from personal_data_reads
            where location_id = $1 and staff_id = $2 and context = 'client_search' order by id`,
          [String(A.location), String(A.users.reception.staffId)],
        )
      ).rows;
    // Un cliente propio de esta prueba: otras ya buscaron a "Juan" en esta misma ventana de 10
    // minutos, y esa lectura no se repite.
    const seen = await findOrCreateClient(db, { locationId: A.location, name: "Zoila Auditoría", phone: "300 765 4321" });
    const before = (await reads()).length;
    await signInAs(A.users.reception);
    const found = await agenda.findClients("Zoila");
    expect(found.ok).toBe(true);
    await agenda.findClients("Zoila");
    const after = await reads();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.clients.split(",")).toEqual([String(seen.id)]);
  });
});

// ─── Comprobantes: un 404 igual para todo lo ajeno (sprint 5) ────────────────

const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

describe("comprobantes", () => {
  it("el barbero abre el suyo y recibe 404 con el de otro, igual que si no existiera", async () => {
    const publicId = await seedSettlement();
    await signInAs(A.users.barber);
    expect(await comprobantes.loadReceipt({ publicId })).toMatchObject({ ok: true, data: { kind: "settlement", numberLabel: expect.stringMatching(/^N\.º /) } });

    const other = await personWithSession("barber", A.location);
    await signInAs(other);
    await expect(comprobantes.loadReceipt({ publicId })).rejects.toMatchObject(NOT_FOUND);
    await expect(comprobantes.loadReceipt({ publicId: "no-es-un-ulid" })).rejects.toMatchObject(NOT_FOUND);
    await expect(comprobantes.loadReceipt({ publicId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).rejects.toMatchObject(NOT_FOUND);
  });

  it("el dueño de otra sede recibe 404 con el comprobante de esta; también con un anticipo", async () => {
    const settlement = await seedSettlement();
    const advance = await seedAdvance();
    await signInAs(B.owner);
    await expect(comprobantes.loadReceipt({ publicId: settlement })).rejects.toMatchObject(NOT_FOUND);
    await expect(comprobantes.loadReceipt({ publicId: advance })).rejects.toMatchObject(NOT_FOUND);
  });

  it("no lleva datos del cliente", async () => {
    const publicId = await seedSettlement();
    await signInAs(A.users.owner);
    expect(JSON.stringify(await comprobantes.loadReceipt({ publicId }))).not.toMatch(/Juan|Pérez|300 123/);
  });
});

// ─── Recibos de venta: un 404 igual para todo lo ajeno ───────────────────────

describe("recibos de venta", () => {
  it("el dueño de otra sede recibe 404; un id inválido o inexistente, también", async () => {
    const publicId = await salePublicId(await seedSale());
    await signInAs(B.owner);
    await expect(ventas.loadSaleReceipt({ publicId })).rejects.toMatchObject(NOT_FOUND);
    await signInAs(A.users.owner);
    await expect(ventas.loadSaleReceipt({ publicId: "no-es-un-ulid" })).rejects.toMatchObject(NOT_FOUND);
    await expect(ventas.loadSaleReceipt({ publicId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).rejects.toMatchObject(NOT_FOUND);
  });

  it("el recibo trae lo cobrado y no lleva datos del cliente", async () => {
    await cashDrawer(true);
    const publicId = await salePublicId(await seedSale({ kind: "cash", tip: 2_000n }));
    await signInAs(A.users.reception);
    const result = await ventas.loadSaleReceipt({ publicId });
    expect(result).toMatchObject({ ok: true, data: { publicId, voided: false, numberLabel: publicId.slice(-8) } });
    if (!result.ok) return;
    expect(result.data.tips).toHaveLength(1);
    expect(result.data.payments[0]).toMatchObject({ amountLabel: result.data.totalLabel });
    // El cliente de la cita es "Juan Pérez", 300 123 4567; ese mismo número es el de la sede en otro
    // caso, así que se busca el nombre y el celular guardado (E.164), no el teléfono formateado.
    expect(JSON.stringify(result)).not.toMatch(/Juan|Pérez|\+57300|client/i);
  });

  it("recepción ve solo hoy aunque pida otro día; el dueño navega", async () => {
    const today = businessDate(new Date(), TZ);
    const yesterday = addDays(today, -1);
    await signInAs(A.users.reception);
    expect(await ventas.loadSalesOfDay({ date: yesterday })).toMatchObject({ ok: true, data: { businessDate: today, canPickDay: false } });
    await signInAs(A.users.owner);
    expect(await ventas.loadSalesOfDay({ date: yesterday })).toMatchObject({ ok: true, data: { businessDate: yesterday, canPickDay: true } });
    // Un día futuro o mal escrito vuelve a hoy.
    expect(await ventas.loadSalesOfDay({ date: addDays(today, 3) })).toMatchObject({ ok: true, data: { businessDate: today } });
    expect(await ventas.loadSalesOfDay({ date: "ayer" })).toMatchObject({ ok: true, data: { businessDate: today } });
  });

  it("al cobrar con 'enviar el recibo', queda en cola por WhatsApp; reintentar no lo duplica", async () => {
    const id = await chairAppointment();
    const units = String((await servicePrice()) / 100n);
    const idempotencyKey = `cobro-recibo-${uniq()}`;
    const pay = () =>
      cobro.checkoutAction({
        appointmentId: String(id),
        extras: [],
        discounts: [],
        tips: [],
        payments: [{ methodId: String(A.methods.card), amountUnits: units }],
        idempotencyKey,
        sendReceipt: true,
      });
    await signInAs(A.users.reception);
    const first = await pay();
    expect(first).toMatchObject({ ok: true, data: { receiptRequested: true, receiptSent: "whatsapp" } });
    expect(await pay()).toMatchObject({ ok: true, data: { receiptSent: "whatsapp" } });
    if (!first.ok) return;
    const { rows } = await client.query<{ n: string }>(`select count(*)::text as n from notifications where dedupe_key = $1`, [`sale_receipt:${first.data.publicId}`]);
    expect(rows[0]!.n).toBe("1");
  });

  it("sin pedirlo, no se encola nada", async () => {
    const id = await chairAppointment();
    const units = String((await servicePrice()) / 100n);
    await signInAs(A.users.reception);
    const res = await cobro.checkoutAction({
      appointmentId: String(id),
      extras: [],
      discounts: [],
      tips: [],
      payments: [{ methodId: String(A.methods.card), amountUnits: units }],
      idempotencyKey: `cobro-sin-${uniq()}`,
    });
    expect(res).toMatchObject({ ok: true, data: { receiptRequested: false, receiptSent: null } });
    if (!res.ok) return;
    const { rows } = await client.query<{ n: string }>(`select count(*)::text as n from notifications where dedupe_key = $1`, [`sale_receipt:${res.data.publicId}`]);
    expect(rows[0]!.n).toBe("0");
  });

  it("una venta anulada se reimprime con el sello y sale marcada en la lista", async () => {
    const saleId = await seedSale();
    const publicId = await salePublicId(saleId);
    const { requestId } = await requestVoid(db, { locationId: A.location, saleId, reason: "Se cobró dos veces", idempotencyKey: `void-${uniq()}`, actor: { userId: "seed" } });
    await decideVoid(db, { locationId: A.location, requestId, approve: true, note: "", idempotencyKey: `decide-${uniq()}`, approver: { userId: A.users.owner.id, role: "owner" } });
    await signInAs(A.users.owner);
    expect(await ventas.loadSaleReceipt({ publicId })).toMatchObject({ ok: true, data: { voided: true } });
    const list = await ventas.loadSalesOfDay({});
    expect(list.ok && list.data.sales.find((s) => s.publicId === publicId)).toMatchObject({ voided: true });
  });

  it("la lista del día es solo de esta sede", async () => {
    const publicId = await salePublicId(await seedSale());
    await signInAs(B.owner);
    const result = await ventas.loadSalesOfDay({});
    expect(result.ok && result.data.sales.some((s) => s.publicId === publicId)).toBe(false);
    await signInAs(A.users.owner);
    const own = await ventas.loadSalesOfDay({});
    expect(own.ok && own.data.sales.some((s) => s.publicId === publicId)).toBe(true);
  });
});

describe("mis comisiones", () => {
  it("solo trae lo de quien tiene la sesión, aunque otra persona tenga más pendiente", async () => {
    await seedAdvance();
    const other = await personWithSession("barber", A.location);
    await signInAs(other);
    expect(await misComisiones.loadMyCommissions()).toMatchObject({ ok: true, data: { pending: { totalMinor: "0", lines: [] }, settlements: [], advances: [], clawbacks: [] } });
  });
});

describe("liquidar con una sesión vieja", () => {
  it("liquidar, revertir y cualquier anticipo piden confirmar identidad", async () => {
    const previewToken = await pendingSettlement();
    const settled = await seedSettlementAfterPending();
    const advance = await seedAdvance();
    await signInAs(A.users.owner, { stale: true });
    await cashDrawer(true);
    await seedSale({ kind: "cash" });
    const before = await fingerprint();
    for (const attempt of [
      () => comisiones.settleCommissionsAction({ ...settlementInput(), previewToken, idempotencyKey: `settle-${uniq()}` }),
      () => comisiones.reverseSettlementAction({ publicId: settled, reason: "Se liquidó de más", idempotencyKey: `undo-${uniq()}` }),
      () => comisiones.reverseAdvanceAction({ publicId: advance, reason: "No se entregó", idempotencyKey: `undo-${uniq()}` }),
      () => comisiones.giveAdvanceAction({ staffId: String(A.users.barber.staffId), amountUnits: "1000", paidFrom: "bank", reason: "Adelanto", idempotencyKey: `adv-${uniq()}` }),
      () => comisiones.giveAdvanceAction({ staffId: String(A.users.barber.staffId), amountUnits: "1000", paidFrom: "cash", reason: "Adelanto", idempotencyKey: `adv-${uniq()}` }),
    ]) {
      expect(await attempt()).toMatchObject({ ok: false, code: "reauth_required" });
    }
    expect(await fingerprint()).toBe(before);
  });
});

/** Una liquidación ya hecha, sin tocar lo pendiente de otro token (la del caso anterior ya lo calculó). */
async function seedSettlementAfterPending(): Promise<string> {
  const previewToken = (await previewSettlement(db, settlementOptions())).previewToken;
  const done = await settleCommissions(db, { ...settlementOptions(), previewToken, idempotencyKey: `seed-settle-${uniq()}`, actor: SEED_ACTOR() });
  await seedSale();
  return done.publicId;
}

// ─── Exportación CSV ─────────────────────────────────────────────────────────

describe("exportar informes", () => {
  it("cada informe sale con BOM, punto y coma y su evento de auditoría; las fórmulas no se ejecutan", async () => {
    await signInAs(A.users.owner);
    const name = `=HYPERLINK("x") ${uniq()}`;
    expect(await servicios.createServiceAction({ name, priceUnits: "20000", durationMin: 30, bufferMin: 5, commission: "40", active: true })).toMatchObject({ ok: true });
    const [created] = await db.select({ id: services.id }).from(services).where(eq(services.name, name));
    const appointmentId = await chairAppointment();
    await checkout(db, {
      locationId: A.location,
      appointmentId,
      extras: [{ serviceId: created!.id, staffId: A.users.barber.staffId }],
      discounts: [],
      tips: [],
      payments: [{ methodId: A.methods.card, amount: money((await servicePrice()) + fromUnits(20_000n).minor) }],
      idempotencyKey: `seed-sale-${uniq()}`,
      actor: SEED_ACTOR(),
    });
    const day = businessDate(new Date(), TZ);
    for (const report of CSV_REPORTS) {
      const result = await informes.exportReportCsvAction({ report, from: day, to: day });
      if (!result.ok) throw new Error(result.error);
      expect(result.data.filename).toMatch(new RegExp(`^villa-.+-${day}-a-${day}\\.csv$`));
      expect(result.data.csv.startsWith("\uFEFF")).toBe(true);
    }
    const byService = await informes.exportReportCsvAction({ report: "by_service", from: day, to: day });
    if (!byService.ok) throw new Error(byService.error);
    expect(byService.data.csv).toContain(`"'=HYPERLINK(""x"") `);
    expect(byService.data.csv).not.toMatch(/(^|;|\r\n)=/);
  });

  it("M-2: el nombre de un cliente en un motivo o una nota libre no llega a ningún CSV", async () => {
    const secret = "Rodrigo Quintero, cel 301 555 0199";
    await cashDrawer(true);
    const saleId = await seedSale({ kind: "cash" });
    const { requestId } = await requestVoid(db, { locationId: A.location, saleId, reason: `Lo pidió ${secret}`, idempotencyKey: `void-${uniq()}`, actor: { userId: "seed" } });
    await decideVoid(db, { locationId: A.location, requestId, approve: true, note: secret, idempotencyKey: `decide-${uniq()}`, approver: { userId: A.users.owner.id, role: "owner" } });
    // Una diferencia de caja con nota libre.
    const counted = money((await ledgerCash(db, A.location)) + 100n);
    await closeCashSession(db, { locationId: A.location, counted, note: `Sobró, se lo dejó ${secret}`, idempotencyKey: `close-${uniq()}`, actor: { userId: "seed" } });
    await signInAs(A.users.owner);
    const day = businessDate(new Date(), TZ);
    for (const report of CSV_REPORTS) {
      const result = await informes.exportReportCsvAction({ report, from: day, to: day });
      if (!result.ok) throw new Error(result.error);
      expect(result.data.csv, report).not.toContain("Rodrigo");
      expect(result.data.csv, report).not.toContain("301 555");
    }
    const journal = await informes.exportReportCsvAction({ report: "journal", from: day, to: day });
    expect(journal.ok && journal.data.csv).toContain("Reversa");
    // La nota sigue en la pantalla de diferencias: solo se quita del archivo.
    const view = await informes.loadReport({ from: day, to: day });
    expect(view.ok && view.data.cashDifferences.items.some((i) => i.note?.includes("Rodrigo"))).toBe(true);
    await cashDrawer(true);
  });

  it("un periodo inválido no exporta ni deja evento", async () => {
    await signInAs(A.users.owner);
    const before = await fingerprint();
    expect(await informes.exportReportCsvAction({ report: "pnl", from: "2026-01-02", to: "2026-01-01" })).toMatchObject({ ok: false });
    expect(await fingerprint()).toBe(before);
  });
});

// ─── Auditoría: cada escritura deja exactamente un evento (sprint 5) ─────────

/** Toda acción de escritura del dinero, la configuración y el personal, con su evento. */
const AUDITED: Record<string, AuditAction> = {
  eraseClientAction: "client.erase",
  clearNoShowsAction: "client.no_shows_clear",
  clearClientNoShowsAction: "client.no_shows_clear",
  withdrawConsentAction: "client.consent_withdraw",
  forgetClientDevicesAction: "client.devices_forget",
  checkoutAction: "sale.checkout",
  requestVoidAction: "void.request",
  decideVoidAction: "void.approve",
  openCashSessionAction: "cash.open",
  closeCashSessionAction: "cash.close",
  markCashSessionReviewedAction: "cash.review",
  addExpenseAction: "expense.add",
  payTipsAction: "tips.pay",
  cashDepositAction: "cash.deposit",
  closeDayAction: "day.close",
  reopenDayAction: "day.reopen",
  settleCommissionsAction: "settlement.create",
  reverseSettlementAction: "settlement.reverse",
  giveAdvanceAction: "advance.create",
  reverseAdvanceAction: "advance.reverse",
  giveCourtesyAction: "appointment.courtesy",
  registerRecurringExpenseAction: "recurring_expense.register",
  skipRecurringExpenseAction: "recurring_expense.skip",
  saveRecurringExpenseAction: "recurring_expense.save",
  createServiceAction: "service.create",
  updateServiceAction: "service.update",
  setServiceActiveAction: "service.active",
  updateBookingSettingsAction: "settings.booking",
  updateCheckoutRulesAction: "settings.checkout_rules",
  savePaymentMethodAction: "payment_method.save",
  saveExpenseCategoryAction: "expense_category.save",
  setStaffBookableAction: "staff.bookable",
  createStaffAction: "staff.create",
  updateStaffProfileAction: "staff.update",
  resetStaffPasswordAction: "staff.password_reset",
  revokeStaffSessionsAction: "staff.sessions_revoke",
  saveScheduleAction: "schedule.save",
  saveStaffServicesAction: "staff.update",
  exportReportCsvAction: "report.export",
};

/** Los módulos con historial propio (citas y bloqueos, §8) o de la cuenta de cada quien. */
const NOT_AUDITED_MODULES = ["panel/actions.ts", "panel/agenda/actions.ts", "panel/bloqueos/actions.ts", "cuenta/actions.ts"];
const isRead = (name: string) => /^load/.test(name);

describe("cada acción de escritura deja exactamente un evento", () => {
  it("toda acción de los módulos auditados es una lectura o está en AUDITED", () => {
    const missing = Object.entries(STAFF_MODULES)
      .filter(([file]) => !NOT_AUDITED_MODULES.includes(file))
      .flatMap(([file, m]) =>
        Object.entries(m)
          .filter(([name, v]) => typeof v === "function" && !isRead(name) && !(name in AUDITED))
          .map(([name]) => `${file}: ${name}`),
      );
    expect(missing).toEqual([]);
  });

  const auditCases = CASES.filter((c) => c.action in AUDITED);

  it("hay una prueba para cada acción de AUDITED", () => {
    expect([...new Set(auditCases.map((c) => c.action))].sort()).toEqual(Object.keys(AUDITED).sort());
  });

  it.each(auditCases)("$name", async (c) => {
    const count = async () => {
      const [row] = (await client.query<{ n: string }>(`select count(*)::text as n from audit_events where action = $1`, [AUDITED[c.action]!])).rows;
      return Number(row!.n);
    };
    const attempt = await c.prepare();
    const before = await count();
    const role = c.allowed.includes("owner") ? "owner" : c.allowed[0]!;
    await signInAs(A.users[role]);
    const result = await attempt();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    // decideVoidAction de la matriz puede aprobar o rechazar: se cuenta el evento que corresponda.
    if (c.action === "decideVoidAction" && (await count()) === before) {
      const { rows } = await client.query<{ n: string }>(`select count(*)::text as n from audit_events where action = 'void.reject'`);
      expect(Number(rows[0]!.n)).toBeGreaterThan(0);
      return;
    }
    expect(await count()).toBe(before + 1);
  });

  it("los cambios de configuración guardan el antes y el después, sin datos sensibles", async () => {
    await signInAs(A.users.owner);
    const price = String(40_000 + Number(uniq()));
    expect(
      await servicios.updateServiceAction({ serviceId: String(A.service), name: "Corte", priceUnits: price, durationMin: 30, bufferMin: 10, commission: "40", active: true }),
    ).toMatchObject({ ok: true });
    const log = await auditoria.loadAuditLog({ category: "configuracion" });
    if (!log.ok) throw new Error(log.error);
    const event = log.data.events.find((e) => e.actionLabel && e.changes.some((ch) => ch.field === "Precio"));
    expect(event?.changes.find((ch) => ch.field === "Precio")?.after).toMatch(/^\$\s/);

    const k = uniq();
    expect(
      await personal.createStaffAction({ withAccess: true, name: `Nueva ${k}`, role: "barber", email: `nueva${k}@villa.test`, password: TEMP_PASSWORD }),
    ).toMatchObject({ ok: true });
    const { rows } = await client.query<{ row: string }>(`select row(a.*)::text as row from audit_events a where a.action in ('staff.create', 'staff.password_reset')`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.row).not.toContain(TEMP_PASSWORD);
      expect(r.row).not.toContain(PASSWORD);
      expect(r.row).not.toContain("@villa.test");
    }
  });

  it("la bitácora pagina con cursor y no cruza sedes", async () => {
    await signInAs(B.owner);
    const other = await auditoria.loadAuditLog({});
    if (!other.ok) throw new Error(other.error);
    expect(other.data.events.every((e) => !/Corte$/.test(e.summary))).toBe(true);
    await signInAs(A.users.owner);
    const first = await auditoria.loadAuditLog({});
    if (!first.ok) throw new Error(first.error);
    expect(first.data.events).toHaveLength(50);
    expect(first.data.nextCursor).not.toBeNull();
    const second = await auditoria.loadAuditLog({ before: first.data.nextCursor! });
    if (!second.ok) throw new Error(second.error);
    expect(BigInt(second.data.events[0]!.id)).toBeLessThan(BigInt(first.data.nextCursor!));
  });
});

// ─── Cortesías (sprint 8, docs/sprint-8-gastos-controles.md §4) ──────────────

describe("cortesías", () => {
  it("recepción la da solo si la sede la deja dar descuentos; con el tope bajo 100 % nadie, y la caja no ofrece el botón", async () => {
    await courtesyRules(A.location, { receptionCanDiscount: true });
    const id = await chairAppointment();
    await signInAs(A.users.reception);
    const view = await caja.loadCashView();
    expect(view.ok && view.data.canCourtesy).toBe(true);
    expect(await caja.giveCourtesyAction({ appointmentId: String(id), reason: "Cliente afectado por la espera" })).toMatchObject({ ok: true, data: { created: true } });
    // Repetir devuelve la misma.
    expect(await caja.giveCourtesyAction({ appointmentId: String(id), reason: "Otra vez" })).toMatchObject({ ok: true, data: { created: false } });
    const after = await caja.loadCashView();
    expect(after.ok && after.data.toCharge.some((a) => a.appointmentId === String(id))).toBe(false);

    await courtesyRules(A.location, { maxDiscountBps: 3_000, receptionCanDiscount: true });
    const other = await chairAppointment();
    await signInAs(A.users.owner);
    const capped = await caja.loadCashView();
    expect(capped.ok && capped.data.canCourtesy).toBe(false);
    const before = await fingerprint();
    const refused = await caja.giveCourtesyAction({ appointmentId: String(other), reason: "Cumpleaños" });
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.error).toMatch(/tope de descuento/);
    expect(await fingerprint()).toBe(before);
    await courtesyRules(A.location);
  });

  it("la que se dio como cortesía no se cobra", async () => {
    await courtesyRules(A.location);
    const id = await chairAppointment();
    await signInAs(A.users.owner);
    expect(await caja.giveCourtesyAction({ appointmentId: String(id), reason: "Cortesía de la casa" })).toMatchObject({ ok: true });
    await expect(
      checkout(db, {
        locationId: A.location,
        appointmentId: id,
        extras: [],
        discounts: [],
        tips: [],
        payments: [{ methodId: A.methods.card, amount: money(await servicePrice()) }],
        idempotencyKey: `seed-sale-${uniq()}`,
        actor: SEED_ACTOR(),
      }),
    ).rejects.toThrow(/cortesía/);
  });

  it("Inicio avisa al dueño las cortesías de los últimos 7 días que no dio él, con enlace al informe", async () => {
    const courtesiesAlert = async () => {
      await signInAs(A.users.owner);
      const dash = await inicio.loadDashboard();
      if (!dash.ok) throw new Error(dash.error);
      return dash.data.alerts.find((a) => a.kind === "courtesies");
    };
    const before = (await courtesiesAlert())?.count ?? 0;
    await courtesyRules(A.location, { receptionCanDiscount: true });

    // Una de recepción suma.
    const byReception = await chairAppointment();
    await signInAs(A.users.reception);
    expect(await caja.giveCourtesyAction({ appointmentId: String(byReception), reason: "Cliente afectado por la espera" })).toMatchObject({ ok: true });
    const alert = await courtesiesAlert();
    expect(alert).toMatchObject({ count: before + 1 });
    expect(alert?.label).toMatch(/cortesías? en los últimos 7 días/);
    const today = businessDate(new Date(), TZ);
    expect(alert?.href).toBe(`/panel/informes?desde=${addDays(today, -6)}&hasta=${today}#sec-courtesies`);

    // Una del dueño no (la dio él mismo: no tiene que avisarse).
    const byOwner = await chairAppointment();
    expect(await caja.giveCourtesyAction({ appointmentId: String(byOwner), reason: "Cortesía de la casa" })).toMatchObject({ ok: true });
    expect(await courtesiesAlert()).toMatchObject({ count: before + 1 });
    await courtesyRules(A.location);
  });
});

// ─── Gastos fijos (sprint 8, docs/sprint-8-gastos-controles.md §5) ───────────

describe("gastos fijos", () => {
  it("registrar uno de banco pide confirmar identidad; sin ella no toca nada y tras confirmar pasa", async () => {
    const recurringId = await seedRecurring("bank");
    const attempt = () => gastosFijos.registerRecurringExpenseAction({ recurringId, period: thisPeriod(), amountUnits: "800000", description: "Arriendo" });
    await signInAs(A.users.owner, { stale: true });
    const before = await fingerprint();
    expect(await attempt()).toMatchObject({ ok: false, code: "reauth_required" });
    expect(await fingerprint()).toBe(before);
    expect(await cuenta.reauthenticateAction({ method: "totp", code: state.totpCode })).toMatchObject({ ok: true });
    expect(await attempt()).toMatchObject({ ok: true, data: { created: true } });
    // Repetir (doble toque) devuelve el mismo gasto y no deja otro.
    const after = await fingerprint();
    expect(await attempt()).toMatchObject({ ok: true, data: { created: false } });
    expect(await fingerprint()).toBe(after);
  });

  it("registrar uno de caja no la pide (pasa por el conteo de la caja)", async () => {
    await drawerWithCash();
    const recurringId = await seedRecurring("cash");
    await signInAs(A.users.owner, { stale: true });
    expect(await gastosFijos.registerRecurringExpenseAction({ recurringId, period: thisPeriod(), amountUnits: "4000", description: "Aseo" })).toMatchObject({
      ok: true,
    });
  });

  it("recepción ve en Caja los de caja por pagar (no los de banco); el dueño ve los vencidos en Inicio", async () => {
    const lastMonth = `${addDays(thisPeriod(), -1).slice(0, 7)}-01`;
    const cash = await seedRecurring("cash", { startMonth: lastMonth });
    const bank = await seedRecurring("bank");
    await signInAs(A.users.reception);
    const view = await caja.loadCashView();
    if (!view.ok) throw new Error(view.error);
    const mine = view.data.recurringDue.filter((d) => d.recurringId === cash);
    expect(mine.map((d) => d.period)).toEqual([lastMonth, thisPeriod()]);
    expect(mine[0]).toMatchObject({ status: "overdue", payMode: "cash" });
    expect(view.data.recurringDue.some((d) => d.recurringId === bank)).toBe(false);

    await signInAs(A.users.owner);
    const dash = await inicio.loadDashboard();
    if (!dash.ok) throw new Error(dash.error);
    expect(dash.data.alerts.find((a) => a.kind === "recurring_overdue")).toMatchObject({ href: "/panel/gastos-fijos" });
  });

  it("de otra sede no se ve nada en Caja ni en Gastos fijos", async () => {
    const id = await seedRecurring("cash");
    await signInAs(B.owner);
    const list = await gastosFijos.loadRecurringExpenses();
    if (!list.ok) throw new Error(list.error);
    expect(list.data.templates.some((t) => t.id === id)).toBe(false);
    const view = await caja.loadCashView();
    if (!view.ok) throw new Error(view.error);
    expect(view.data.recurringDue.some((d) => d.recurringId === id)).toBe(false);
  });
});

// ─── Envíos detenidos (latido del worker, migración 0030) ────────────────────

describe("envíos detenidos", () => {
  afterAll(() => vi.unstubAllEnvs());

  /** Un cobro con "enviar el recibo": deja un sale_receipt en cola en la sede A. */
  async function queuedReceipt(): Promise<void> {
    const id = await chairAppointment();
    const units = String((await servicePrice()) / 100n);
    await signInAs(A.users.reception);
    const res = await cobro.checkoutAction({
      appointmentId: String(id),
      extras: [],
      discounts: [],
      tips: [],
      payments: [{ methodId: String(A.methods.card), amountUnits: units }],
      idempotencyKey: `cobro-cola-${uniq()}`,
      sendReceipt: true,
    });
    expect(res).toMatchObject({ ok: true, data: { receiptSent: "whatsapp" } });
  }

  it("sin latido y con recibos en cola: Caja, Inicio y la hoja de cobro lo dicen; con latido, no", async () => {
    // Sin credenciales: en tests (como en desarrollo) el notificador de los dos canales es la consola.
    for (const name of ["WHATSAPP_TOKEN", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "RESEND_API_KEY", "EMAIL_FROM"]) vi.stubEnv(name, "");
    await db.delete(workerHeartbeats);
    await queuedReceipt();

    await signInAs(A.users.reception);
    expect(await caja.loadCashView()).toMatchObject({ ok: true, data: { deliveryStalled: true } });
    const chair = await chairAppointment();
    expect(await cobro.loadCheckout({ appointmentId: String(chair) })).toMatchObject({
      ok: true,
      data: { receipt: { modes: { whatsapp: "stopped", email: "stopped" } } },
    });
    expect(await cobro.loadWalkInCheckout()).toMatchObject({ ok: true, data: { receipt: { modes: { whatsapp: "stopped", email: "stopped" } } } });
    await signInAs(A.users.owner);
    expect(await inicio.loadDashboard()).toMatchObject({ ok: true, data: { deliveryStalled: true } });

    // La otra sede no tiene nada en cola: no ve el aviso (el latido es global; la cola, por sede).
    await signInAs(B.owner);
    expect(await caja.loadCashView()).toMatchObject({ ok: true, data: { deliveryStalled: false } });
    expect(await inicio.loadDashboard()).toMatchObject({ ok: true, data: { deliveryStalled: false } });

    // El worker vuelve: el aviso se va y la hoja dice la verdad del notificador (consola en pruebas).
    await recordHeartbeat(db, new Date());
    await signInAs(A.users.reception);
    expect(await caja.loadCashView()).toMatchObject({ ok: true, data: { deliveryStalled: false } });
    expect(await cobro.loadWalkInCheckout()).toMatchObject({ ok: true, data: { receipt: { modes: { whatsapp: "console", email: "console" } } } });
    await signInAs(A.users.owner);
    expect(await inicio.loadDashboard()).toMatchObject({ ok: true, data: { deliveryStalled: false } });
  });

  it("latido de hace más de 5 minutos: detenidos otra vez", async () => {
    await queuedReceipt();
    await recordHeartbeat(db, new Date(Date.now() - 6 * 60_000));
    await signInAs(A.users.reception);
    const view = await caja.loadCashView();
    expect(view).toMatchObject({ ok: true, data: { deliveryStalled: true } });
    // Solo un booleano: nada del cliente ni de la cola.
    expect(JSON.stringify(view)).not.toMatch(/sale_receipt|recipient/);
  });
});
