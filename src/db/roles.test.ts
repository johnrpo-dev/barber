import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite as PGliteDb, type PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { fromUnits } from "@/domain/money";
import { createAuth } from "@/lib/auth";
import { changeStatus, createAppointment, rescheduleAppointment } from "./appointments";
import { createService, updateService } from "./catalog";
import { findOrCreateClient } from "./clients";
import { recordConsents } from "./consents";
import { markReauthenticated, resetStaffPassword } from "./credentials";
import { closeDay, createLocation, postEntry, reopenDay, reverseEntry } from "./ledger";
import { clearFailures, reserveAttempt, userThrottleSubject } from "./login-throttle";
import { issueManageLink, revokeManageLinks } from "./manage-links";
import { hit, pruneRateLimits } from "./rate-limit";
import { createStaffUser, setStaffActive, setWeeklySchedule, updateStaffMember } from "./staff";
import { createTestDb, dbError } from "./testing";
import { addTimeOff, cancelTimeOff } from "./time-off";
import { cashDeposit, closeBusinessDay, closeCashSession, ledgerCash, openCashSession, payTips, reopenBusinessDay } from "./cash";
import { saveExpenseCategory, savePaymentMethod, updateCheckoutRules } from "./checkout-settings";
import { addExpense } from "./expenses";
import { key, quickSale, setupShop, TZ as SHOP_TZ } from "./sales-testing";
import { decideVoid, requestVoid } from "./voids";
import { money } from "@/domain/money";
import type { Db } from "./types";

// Separación de roles de Postgres (docs/arquitectura.md, "Seguridad"): las migraciones corren como
// villa_owner y la app como villa_app. Aquí se prueba, con los mismos GRANT de la migración 0009,
// que la app hace su trabajo normal y que NO puede editar ni borrar el libro ni lo solo-inserción,
// ni cambiar el esquema, ni apagar los triggers que lo protegen.

const TZ = "America/Bogota";
const PASSWORD = "navaja-y-cuero-2026"; // valor de prueba, solo existe en esta base en memoria

let db: Db;
let client: PGlite;
let locationId: bigint;
let appointmentId: bigint;

beforeAll(async () => {
  ({ db, client } = await createTestDb({ role: "app" }));
  locationId = await createLocation(db, { name: "Villa" });
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("la app corre como villa_app", () => {
  it("no es superusuario ni dueña de las tablas", async () => {
    const { rows } = await client.query<{ who: string; su: boolean; owner: string }>(
      `select current_user as who, (select rolsuper from pg_roles where rolname = current_user) as su,
              (select tableowner from pg_tables where tablename = 'journal_entries') as owner`,
    );
    expect(rows[0]).toEqual({ who: "villa_app", su: false, owner: "villa_owner" });
  });

  it("hace el trabajo diario: personal, agenda, cobros, cierre, enlaces y consentimientos", { timeout: 120_000 }, async () => {
    const owner = await createStaffUser(db, { locationId, name: "Dueño", email: "dueno@villa.test", password: PASSWORD, role: "owner" });
    const barber = await createStaffUser(db, { locationId, name: "Andrés", email: "andres@villa.test", password: PASSWORD, role: "barber" });
    await updateStaffMember(db, { locationId, staffId: barber.staffId, displayName: "Andrés R.", role: "barber" });
    const allDay = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: 0, endMin: 1440 }));
    await setWeeklySchedule(db, { locationId, staffId: barber.staffId, blocks: allDay });
    await setWeeklySchedule(db, { locationId, staffId: barber.staffId, blocks: allDay }); // reemplazar = DELETE + INSERT

    const service = await createService(db, {
      locationId,
      draft: { name: "Corte", durationMin: 30, bufferMin: 10, price: fromUnits(30_000n), commissionBps: 4_000 },
    });
    await updateService(db, { locationId, serviceId: service.id, draft: { name: "Corte", durationMin: 30, bufferMin: 10, price: fromUnits(32_000n), commissionBps: 4_000 } });
    const juan = await findOrCreateClient(db, { locationId, name: "Juan Pérez", phone: "300 123 4567" });

    const date = addDays(businessDate(new Date(), TZ), 3);
    const appt = await createAppointment(db, {
      locationId,
      serviceId: service.id,
      staffId: barber.staffId,
      start: localMinuteToInstant(date, 600, TZ),
      clientId: juan.id,
      source: "staff",
      idempotencyKey: "roles-1",
      createdBy: owner.userId,
    });
    appointmentId = appt.appointmentId;
    const actor = { userId: owner.userId, role: "owner" as const, staffId: owner.staffId };
    await rescheduleAppointment(db, { locationId, appointmentId, staffId: barber.staffId, start: localMinuteToInstant(date, 660, TZ), actor });
    await issueManageLink(db, {
      locationId,
      appointmentId,
      publicId: appt.publicId,
      appointmentEnd: localMinuteToInstant(date, 700, TZ),
      secret: "s".repeat(40),
    });
    await recordConsents(db, {
      locationId,
      clientId: juan.id,
      appointmentId,
      choices: { dataProcessing: true, reminders: true, marketing: false },
      textVersion: "2026-11-01",
      ip: null,
      userAgent: null,
      source: "staff",
    });
    await changeStatus(db, { locationId, appointmentId, to: "cancelled", cancelReason: "client", actor });
    await revokeManageLinks(db, { locationId, appointmentId, reason: "cancelled", now: new Date() });

    const off = await addTimeOff(db, { locationId, staffId: barber.staffId, kind: "block", createdBy: owner.userId, allDay: true, fromDate: date, toDate: date });
    await cancelTimeOff(db, { locationId, timeOffId: off.id });

    const day = "2026-10-28";
    const price = fromUnits(32_000n);
    const sale = await postEntry(db, {
      locationId,
      createdBy: owner.userId,
      entry: {
        businessDate: day,
        // Un asiento suelto: "sale" exige su venta (0011), así que aquí va un aporte del dueño.
        kind: "owner_contribution",
        memo: "Aporte",
        idempotencyKey: "cobro-roles-1",
        lines: [
          { account: ACCOUNTS.cash.code, side: "debit", amount: price },
          { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: price },
        ],
      },
    });
    await reverseEntry(db, { locationId, entryId: sale.entryId, businessDate: day, reason: "Cobro duplicado", createdBy: owner.userId });
    await closeDay(db, { locationId, businessDate: day, createdBy: owner.userId });
    await reopenDay(db, { locationId, businessDate: day, reason: "Faltó un gasto", createdBy: owner.userId });

    // Límites y bloqueos (UPSERT y limpieza).
    await hit(db, "roles:test", new Date());
    await pruneRateLimits(db, new Date(Date.now() + 86_400_000));
    const subject = userThrottleSubject("reauth", owner.userId);
    await reserveAttempt(db, [{ subject, kind: "reauth" }]);
    await clearFailures(db, subject);

    // better-auth: ingresar crea la sesión; reautenticar y reiniciar contraseñas la tocan.
    const auth = createAuth(db, { secret: "s".repeat(32), baseURL: "http://localhost:3000" });
    const signed = await auth.api.signInEmail({ body: { email: "andres@villa.test", password: PASSWORD }, returnHeaders: true });
    const sessionId = (await auth.api.getSession({ headers: new Headers({ cookie: signed.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) }))
      ?.session.id;
    expect(sessionId).toBeTruthy();
    await markReauthenticated(db, { userId: barber.userId, sessionId: sessionId! });
    await resetStaffPassword(db, { locationId, staffId: barber.staffId, password: "otra-clave-temporal" });
    await setStaffActive(db, { locationId, staffId: barber.staffId, active: false });
  });

  it("cobra, mueve la caja, anula y cierra el día (sprint 4)", { timeout: 120_000 }, async () => {
    const shop = await setupShop(db, "Villa caja");
    const cop = (p: bigint) => fromUnits(p);
    const by = shop.owner;
    await updateCheckoutRules(db, shop.locationId, { commissionBase: "net", maxDiscountBps: 2_000n, receptionCanDiscount: true, tipsBearCardFees: true });
    await savePaymentMethod(db, { locationId: shop.locationId, id: shop.methods.card, kind: "card", label: "Datáfono", feeBps: 299n, active: true });
    await savePaymentMethod(db, { locationId: shop.locationId, kind: "wallet", label: "Billetera nueva", feeBps: 0n, active: false });
    await saveExpenseCategory(db, { locationId: shop.locationId, id: shop.category, name: "Insumos y aseo", accountCode: "5195", active: true });
    await openCashSession(db, { locationId: shop.locationId, counted: cop(10_000n), note: "Base", idempotencyKey: key(), actor: by });
    const { saleId } = await quickSale(db, shop, { kind: "cash", tip: 4_000n });
    await quickSale(db, shop, { kind: "card", tip: 2_000n });
    await addExpense(db, { locationId: shop.locationId, categoryId: shop.category, amount: cop(5_000n), paidFrom: "cash", description: "Jabón", idempotencyKey: key(), actor: by });
    await addExpense(db, { locationId: shop.locationId, categoryId: shop.category, amount: cop(50_000n), paidFrom: "bank", description: "Arriendo", idempotencyKey: key(), actor: by });
    await payTips(db, { locationId: shop.locationId, staffId: shop.barber, amount: cop(4_000n), idempotencyKey: key(), actor: by });
    await cashDeposit(db, { locationId: shop.locationId, amount: cop(1_000n), idempotencyKey: key(), actor: by });
    const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId, reason: "Cobro duplicado", idempotencyKey: key(), actor: shop.reception });
    await decideVoid(db, { locationId: shop.locationId, requestId, approve: true, note: "", idempotencyKey: key(), approver: by });
    const counted = money(await ledgerCash(db, shop.locationId));
    await closeCashSession(db, { locationId: shop.locationId, counted, idempotencyKey: key(), actor: by });
    const today = businessDate(new Date(), SHOP_TZ);
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: today, actor: by });
    await reopenBusinessDay(db, { locationId: shop.locationId, businessDate: today, reason: "Prueba de permisos", actor: by });
  });
});

describe("lo que villa_app no puede hacer", () => {
  const denied = /permission denied|must be owner|must be superuser|permiso denegado/i;

  it.each([
    "journal_entries",
    "journal_lines",
    "day_close_events",
    "appointment_events",
    "client_consents",
    "notifications",
    "notification_events",
    "accounts",
  ])("no edita, no borra y no vacía %s", async (table) => {
    expect(await dbError(client.query(`update ${table} set location_id = location_id`))).toMatch(denied);
    expect(await dbError(client.query(`delete from ${table}`))).toMatch(denied);
    expect(await dbError(client.query(`truncate ${table} cascade`))).toMatch(denied);
  });

  it.each(["appointments", "time_off", "booking_verifications", "appointment_links", "clients", "services", "staff_members", "user", "account", "locations"])(
    "no borra filas de %s",
    async (table) => {
      expect(await dbError(client.query(`delete from "${table}"`))).toMatch(denied);
    },
  );

  it.each(["sale_lines", "sale_payments", "sale_tips", "cash_movements", "expenses"])("no edita, no borra y no vacía %s", async (table) => {
    expect(await dbError(client.query(`update ${table} set location_id = location_id`))).toMatch(denied);
    expect(await dbError(client.query(`delete from ${table}`))).toMatch(denied);
    expect(await dbError(client.query(`truncate ${table} cascade`))).toMatch(denied);
  });

  it.each(["sales", "cash_sessions", "void_requests", "payment_methods", "expense_categories"])("no borra ni vacía %s", async (table) => {
    expect(await dbError(client.query(`delete from ${table}`))).toMatch(denied);
    expect(await dbError(client.query(`truncate ${table} cascade`))).toMatch(denied);
  });

  it.each([
    "update sales set total_paid = total_paid",
    "update sales set subtotal = subtotal, discount = discount",
    "update sales set journal_entry_id = journal_entry_id",
    "update sales set location_id = location_id",
    "update cash_sessions set opening_counted = opening_counted",
    "update cash_sessions set opened_at = opened_at",
    "update cash_sessions set opening_entry_id = opening_entry_id",
    "update void_requests set reason = reason",
    "update void_requests set sale_id = sale_id",
    "update payment_methods set location_id = location_id",
    "update expense_categories set location_id = location_id",
  ])("no puede: %s", async (statement) => {
    expect(await dbError(client.query(statement))).toMatch(denied);
  });

  it("no apaga ni borra los triggers que cuadran el libro", async () => {
    expect(await dbError(client.query(`alter table journal_lines disable trigger all`))).toMatch(denied);
    expect(await dbError(client.query(`alter table journal_entries disable trigger user`))).toMatch(denied);
    const { rows } = await client.query<{ tgname: string }>(
      `select tgname from pg_trigger where tgrelid = 'journal_lines'::regclass and not tgisinternal limit 1`,
    );
    expect(rows[0]).toBeDefined();
    expect(await dbError(client.query(`drop trigger ${rows[0]!.tgname} on journal_lines`))).toMatch(denied);
    expect(await dbError(client.query(`set session_replication_role = replica`))).toMatch(denied);
  });

  it("no cambia el esquema ni las funciones", async () => {
    expect(await dbError(client.query(`create table intrusa (id int)`))).toMatch(denied);
    expect(await dbError(client.query(`alter table journal_entries add column x int`))).toMatch(denied);
    expect(await dbError(client.query(`drop table journal_lines`))).toMatch(denied);
    expect(await dbError(client.query(`create or replace function app_apply_grants() returns void language sql as 'select 1'`))).toMatch(denied);
    expect(await dbError(client.query(`select app_apply_grants()`))).toMatch(denied);
    expect(await dbError(client.query(`create schema villa_app`))).toMatch(denied);
    // Quien no es dueño puede escribir GRANT, pero Postgres no concede nada (solo avisa).
    await client.query(`grant update, delete, truncate on journal_entries to villa_app`);
    const { rows } = await client.query<{ u: boolean; d: boolean; t: boolean }>(
      `select has_table_privilege('journal_entries', 'UPDATE') as u, has_table_privilege('journal_entries', 'DELETE') as d,
              has_table_privilege('journal_entries', 'TRUNCATE') as t`,
    );
    expect(rows[0]).toEqual({ u: false, d: false, t: false });
  });

  it("no puede volverse villa_owner", async () => {
    expect(await dbError(client.query(`set role villa_owner`))).toMatch(denied);
  });

  it("con todo eso, el asiento descuadrado lo sigue frenando el trigger, no solo el permiso", async () => {
    // INSERT sí tiene: el constraint trigger de cuadre corre igual para la app.
    const { rows } = await client.query<{ id: string }>(`select id::text from accounts where location_id = $1 and code in ($2, $3) order by code`, [
      String(locationId),
      ACCOUNTS.cash.code,
      ACCOUNTS.serviceIncome.code,
    ]);
    const [a, b] = rows.map((r) => r.id);
    const err = await dbError(
      client.exec(`
        BEGIN;
        INSERT INTO journal_entries (location_id, business_date, kind, memo, currency, created_by)
          VALUES (${locationId}, '2026-10-29', 'sale', 'descuadre', 'COP', 'x');
        INSERT INTO journal_lines (location_id, entry_id, account_id, debit, credit) VALUES
          (${locationId}, currval(pg_get_serial_sequence('journal_entries', 'id')), ${a}, 100, 0),
          (${locationId}, currval(pg_get_serial_sequence('journal_entries', 'id')), ${b}, 0, 99);
        COMMIT;`),
    );
    await client.exec("ROLLBACK").catch(() => {});
    expect(err).not.toMatch(denied);
    expect(err).toMatch(/no cuadra/);
  });
});

// HIGH-1 (auditoría del sprint 4): las funciones de las garantías tienen el search_path fijo, así que
// nadie puede "taparlas" con una función del mismo nombre en otro esquema; y villa_app ya no crea
// nada en ningún esquema (pgboss es de villa_queue).
describe("search_path fijo en las funciones de las garantías (HIGH-1)", () => {
  const denied = /permission denied|must be owner|must be superuser|permiso denegado/i;

  it("toda función plpgsql/sql de public lleva search_path = pg_catalog, public, pg_temp", async () => {
    const { rows } = await client.query<{ name: string; config: string[] | null }>(`
      select p.oid::regprocedure::text as name, p.proconfig as config
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_language l on l.oid = p.prolang
       where n.nspname = 'public' and l.lanname in ('plpgsql', 'sql')
         and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       order by 1`);
    expect(rows.length).toBeGreaterThan(30);
    const loose = rows.filter((r) => !(r.config ?? []).includes("search_path=pg_catalog, public, pg_temp")).map((r) => r.name);
    expect(loose).toEqual([]);
  });

  it("villa_app no crea objetos en pgboss ni en public, ni tablas temporales", async () => {
    expect(await dbError(client.query(`create function pgboss.ledger_assert_entry(p bigint) returns void language sql as 'select'`))).toMatch(denied);
    expect(await dbError(client.query(`create function public.ledger_assert_entry_x(p bigint) returns void language sql as 'select'`))).toMatch(denied);
    expect(await dbError(client.query(`create temp table sombra (id int)`))).toMatch(denied);
    const { rows } = await client.query<{ pgboss: boolean; pub: boolean; temp: boolean }>(
      `select has_schema_privilege('pgboss', 'CREATE') as pgboss, has_schema_privilege('public', 'CREATE') as pub,
              has_database_privilege(current_database(), 'TEMPORARY') as temp`,
    );
    expect(rows[0]).toEqual({ pgboss: false, pub: false, temp: false });
  });

  it("con la instalación vieja (pgboss de villa_app), una función sombra no salta el cuadre", { timeout: 120_000 }, async () => {
    const old = await createTestDb({ role: "app", pgbossOwner: "app" });
    try {
      const loc = await createLocation(old.db, { name: "Villa vieja" });
      const { rows } = await old.client.query<{ id: string }>(`select id::text from accounts where location_id = $1 and code in ($2, $3) order by code`, [
        String(loc),
        ACCOUNTS.cash.code,
        ACCOUNTS.serviceIncome.code,
      ]);
      const [a, b] = rows.map((r) => r.id);
      // El ataque: una ledger_assert_entry() que no revisa nada, en un esquema que va primero.
      await old.client.exec(`
        CREATE FUNCTION pgboss.ledger_assert_entry(p_entry_id bigint) RETURNS void LANGUAGE sql AS 'SELECT';
        SET search_path = pgboss, public;`);
      const { rows: shadow } = await old.client.query<{ ok: boolean }>(`select to_regprocedure('pgboss.ledger_assert_entry(bigint)') is not null as ok`);
      expect(shadow[0]!.ok).toBe(true);
      const err = await dbError(
        old.client.exec(`
          BEGIN;
          INSERT INTO journal_entries (location_id, business_date, kind, memo, currency, created_by)
            VALUES (${loc}, '2026-10-29', 'owner_contribution', 'descuadre', 'COP', 'x');
          INSERT INTO journal_lines (location_id, entry_id, account_id, debit, credit) VALUES
            (${loc}, currval(pg_get_serial_sequence('journal_entries', 'id')), ${a}, 100, 0),
            (${loc}, currval(pg_get_serial_sequence('journal_entries', 'id')), ${b}, 0, 99);
          COMMIT;`),
      );
      await old.client.exec("ROLLBACK").catch(() => {});
      expect(err).toMatch(/no cuadra/);
      const { rows: count } = await old.client.query<{ n: number }>(`select count(*)::int as n from public.journal_entries where memo = 'descuadre'`);
      expect(count[0]!.n).toBe(0);
    } finally {
      await old.client.close();
    }
  });
});

// LOW-1 (auditoría del sprint 4): en una instalación vieja, pgboss y sus tablas eran de villa_app.
// pg-boss particiona la tabla job (job_*): setup-roles.sql debe pasarle a villa_queue TODO, también
// la tabla particionada y cada partición; si no, la siguiente migración de pg-boss falla.
describe("setup-roles.sql: el esquema pgboss pasa entero a villa_queue", () => {
  it("tablas, tabla particionada y particiones, vistas, secuencias, funciones", { timeout: 120_000 }, async () => {
    const script = readFileSync(fileURLToPath(new URL("./roles/setup-roles.sql", import.meta.url)), "utf8");
    const from = script.indexOf("DO $$", script.indexOf("-- ─── Cola del worker"));
    const block = script.slice(from, script.indexOf("\n$$;", from) + 4);
    expect(block).toMatch(/^DO \$\$[\s\S]*\$\$;$/);

    // Una base aparte, sin migraciones: solo los roles y un pgboss de villa_app, como antes.
    const old = { client: new PGliteDb() };
    try {
      await old.client.exec(`
        CREATE ROLE villa_app NOLOGIN; CREATE ROLE villa_queue NOLOGIN;
        CREATE SCHEMA pgboss AUTHORIZATION villa_app;
        SET ROLE villa_app;
        CREATE TABLE pgboss.version (version int PRIMARY KEY);
        CREATE TABLE pgboss.job (id bigserial, name text NOT NULL, data jsonb) PARTITION BY LIST (name);
        CREATE TABLE pgboss.job_a PARTITION OF pgboss.job FOR VALUES IN ('a');
        CREATE TABLE pgboss.job_b PARTITION OF pgboss.job FOR VALUES IN ('b');
        CREATE TABLE pgboss.schedule (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text);
        CREATE SEQUENCE pgboss.loose_seq;
        CREATE VIEW pgboss.jobs_a AS SELECT * FROM pgboss.job_a;
        CREATE FUNCTION pgboss.noop() RETURNS void LANGUAGE sql AS 'SELECT';
        RESET ROLE;`);
      await old.client.exec(block);
      const { rows } = await old.client.query<{ name: string; kind: string; owner: string }>(`
        select c.relname as name, c.relkind::text as kind, pg_get_userbyid(c.relowner) as owner
          from pg_class c where c.relnamespace = 'pgboss'::regnamespace and c.relkind in ('r', 'p', 'S', 'v', 'm', 'i', 'I')
         order by 1`);
      expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["job", "job_a", "job_b", "job_id_seq", "schedule_id_seq", "loose_seq", "jobs_a"]));
      expect(rows.filter((r) => r.owner !== "villa_queue")).toEqual([]);
      const { rows: misc } = await old.client.query<{ schema: string; fn: string; usage: boolean; create: boolean }>(`
        select pg_get_userbyid(n.nspowner) as schema,
               (select pg_get_userbyid(proowner) from pg_proc where oid = 'pgboss.noop()'::regprocedure) as fn,
               has_schema_privilege('villa_app', 'pgboss', 'USAGE') as usage,
               has_schema_privilege('villa_app', 'pgboss', 'CREATE') as create
          from pg_namespace n where n.nspname = 'pgboss'`);
      expect(misc[0]).toEqual({ schema: "villa_queue", fn: "villa_queue", usage: false, create: false });
      // Y villa_queue, ya dueño, sigue la migración de pg-boss: una partición nueva.
      await old.client.exec(`SET ROLE villa_queue; CREATE TABLE pgboss.job_c PARTITION OF pgboss.job FOR VALUES IN ('c'); RESET ROLE;`);
    } finally {
      await old.client.close();
    }
  });
});
