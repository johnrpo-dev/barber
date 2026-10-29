import type { PGlite } from "@electric-sql/pglite";
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
import { clearFailures, recordFailure, userThrottleSubject } from "./login-throttle";
import { issueManageLink, revokeManageLinks } from "./manage-links";
import { hit, pruneRateLimits } from "./rate-limit";
import { createStaffUser, setStaffActive, setWeeklySchedule, updateStaffMember } from "./staff";
import { createTestDb, dbError } from "./testing";
import { addTimeOff, cancelTimeOff } from "./time-off";
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
        kind: "sale",
        memo: "Corte",
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
    await recordFailure(db, subject);
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
