import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { PII_RETENTION_DAYS, READ_AUDIT_RETENTION_DAYS } from "@/domain/clients/retention";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { createAppointment } from "./appointments";
import { createService } from "./catalog";
import { findOrCreateClient } from "./clients";
import { createLocation } from "./ledger";
import { reserveAttempt, userThrottleSubject } from "./login-throttle";
import { purgeExpiredPersonalData, recordContactReads } from "./privacy";
import { deliverSecurityAlerts, enqueueLockAlert, pendingSecurityAlerts, pruneSecurityAlerts } from "./security-alerts";
import { addStaffMember, createStaffUser, setWeeklySchedule } from "./staff";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

// Datos personales (sprint 5, migración 0012): la purga de lo vencido, la auditoría de lecturas y
// el aviso al dueño cuando se dispara un bloqueo. Las reglas las hace cumplir la base; aquí se
// prueban como superusuario (los triggers) y como villa_app (los permisos), como en el VPS.

const TZ = "America/Bogota";
const HEX = (c: string) => c.repeat(64);
const DAY_MS = 86_400_000;

interface Shop {
  db: Db;
  client: PGlite;
  locationId: bigint;
  staffId: bigint;
  appointmentId: bigint;
  newClient: (name: string) => Promise<bigint>;
}

let seq = 0;

async function shop(role?: "app"): Promise<Shop> {
  const { db, client } = await createTestDb(role ? { role } : {});
  const locationId = await createLocation(db, { name: "Villa" });
  await addStaffMember(db, { locationId, displayName: "Dueño", role: "owner" });
  const staffId = await addStaffMember(db, { locationId, displayName: "Andrés", role: "barber" });
  const allDay = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: 0, endMin: 1440 }));
  await setWeeklySchedule(db, { locationId, staffId, blocks: allDay });
  const service = await createService(db, {
    locationId,
    draft: { name: "Corte", durationMin: 30, bufferMin: 0, price: fromUnits(30_000n), commissionBps: 4_000 },
  });
  const juan = (await findOrCreateClient(db, { locationId, name: "Juan Pérez", phone: "300 123 4567" })).id;
  const appt = await createAppointment(db, {
    locationId,
    serviceId: service.id,
    staffId,
    start: localMinuteToInstant(addDays(businessDate(new Date(), TZ), 2), 10 * 60, TZ),
    clientId: juan,
    source: "staff",
    idempotencyKey: `privacy-${++seq}`,
    createdBy: "dueño",
    now: new Date(),
  });
  const newClient = async (name: string) => (await findOrCreateClient(db, { locationId, name, phone: `310 000 ${String(++seq).padStart(4, "0")}` })).id;
  return { db, client, locationId, staffId, appointmentId: appt.appointmentId, newClient };
}

/** Un código ya reemplazado (no vivo) con sus datos personales, creado hace `daysAgo` días. */
async function verification(s: Shop, clientId: bigint, daysAgo: number): Promise<string> {
  const createdAt = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  const { rows } = await s.client.query<{ id: string }>(
    `insert into booking_verifications
       (location_id, appointment_id, client_id, channel, code_hash, browser_hash, expires_at, superseded_at,
        consent_choices, consent_text_version, consent_ip, consent_user_agent, contact_name, contact_email, created_at)
     values ($1, $2, $3, 'whatsapp', $4, $5, $6, $6, '{"dataProcessing":true,"reminders":false,"marketing":false}', '2026-11-01',
             '203.0.113.7', 'Mozilla/5.0 (prueba)', 'Ana María', 'ana@example.test', $6)
     returning id::text`,
    [String(s.locationId), String(s.appointmentId), String(clientId), HEX("a"), HEX("b"), createdAt],
  );
  return rows[0]!.id;
}

async function notification(s: Shop, clientId: bigint, daysAgo: number): Promise<string> {
  const at = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  const { rows } = await s.client.query<{ id: string }>(
    `insert into notifications (location_id, appointment_id, client_id, channel, template, recipient_hash, dedupe_key, send_after, params, created_at)
     values ($1, $2, $3, 'whatsapp', 'booking_confirmed', $4, $5, $6, '{"name":"Ana","service":"Corte"}', $6) returning id::text`,
    [String(s.locationId), String(s.appointmentId), String(clientId), HEX("c"), `privacy:${++seq}`, at],
  );
  return rows[0]!.id;
}

async function pii(s: Shop, id: string) {
  const { rows } = await s.client.query<{ ip: string | null; ua: string | null; name: string | null; email: string | null }>(
    `select consent_ip as ip, consent_user_agent as ua, contact_name as name, contact_email as email from booking_verifications where id = $1`,
    [id],
  );
  return rows[0]!;
}

async function params(s: Shop, id: string): Promise<unknown> {
  const { rows } = await s.client.query<{ params: unknown }>(`select params from notifications where id = $1`, [id]);
  return rows[0]!.params;
}

describe("retenciones: la base y la política de privacidad dicen lo mismo", () => {
  let s: Shop;
  beforeAll(async () => {
    s = await shop();
  }, 120_000);
  afterAll(async () => {
    await s?.client.close();
  });

  it("villa_pii_retention y villa_read_audit_retention coinciden con src/domain/clients/retention.ts", async () => {
    const { rows } = await s.client.query<{ pii: number; reads: number }>(
      `select extract(day from villa_pii_retention())::int as pii, extract(day from villa_read_audit_retention())::int as reads`,
    );
    expect(rows[0]).toEqual({ pii: PII_RETENTION_DAYS, reads: READ_AUDIT_RETENTION_DAYS });
  });
});

describe("purga de datos personales vencidos (superusuario: los triggers)", () => {
  let s: Shop;
  beforeAll(async () => {
    s = await shop();
  }, 120_000);
  afterAll(async () => {
    await s?.client.close();
  });

  it("borra la IP, el navegador, el nombre y el correo de los códigos viejos; los recientes quedan", async () => {
    const juan = await s.newClient("Juan Viejo");
    const old = await verification(s, juan, PII_RETENTION_DAYS + 1);
    const recent = await verification(s, juan, 1);
    const result = await purgeExpiredPersonalData(s.db);
    expect(result.verifications).toBeGreaterThanOrEqual(1);
    expect(await pii(s, old)).toEqual({ ip: null, ua: null, name: null, email: null });
    expect(await pii(s, recent)).toMatchObject({ ip: "203.0.113.7", name: "Ana María" });
    // Lo demás del código (la evidencia del consentimiento elegido) no cambia.
    const { rows } = await s.client.query<{ v: string }>(`select consent_text_version as v from booking_verifications where id = $1`, [old]);
    expect(rows[0]!.v).toBe("2026-11-01");
  });

  it("un cliente anonimizado (supresión) se purga sin esperar la retención", async () => {
    const ana = await s.newClient("Ana Suprimida");
    const v = await verification(s, ana, 1);
    const n = await notification(s, ana, 1);
    await s.client.query(`update clients set anonymized_at = now(), name = 'Anónimo', phone_e164 = null where id = $1`, [String(ana)]);
    await purgeExpiredPersonalData(s.db);
    expect(await pii(s, v)).toEqual({ ip: null, ua: null, name: null, email: null });
    expect(await params(s, n)).toEqual({});
  });

  it("vacía los params de los avisos viejos y deja los recientes", async () => {
    const pedro = await s.newClient("Pedro Avisos");
    const old = await notification(s, pedro, PII_RETENTION_DAYS + 1);
    const recent = await notification(s, pedro, 1);
    await purgeExpiredPersonalData(s.db);
    expect(await params(s, old)).toEqual({});
    expect(await params(s, recent)).toEqual({ name: "Ana", service: "Corte" });
  });

  it("los triggers solo dejan borrar lo vencido, y nada más que eso", async () => {
    const luis = await s.newClient("Luis Reciente");
    const recent = await verification(s, luis, 1);
    expect(
      await dbError(s.client.query(`update booking_verifications set consent_ip = null, consent_user_agent = null, contact_name = null, contact_email = null where id = $1`, [recent])),
    ).toMatch(/dentro de su retención/);
    const old = await verification(s, luis, PII_RETENTION_DAYS + 5);
    // Borrar solo una parte, o tocar otra columna a la vez, no es una purga: sigue prohibido.
    expect(await dbError(s.client.query(`update booking_verifications set consent_ip = null where id = $1`, [old]))).toMatch(/no se editan/);
    expect(
      await dbError(
        s.client.query(
          `update booking_verifications set consent_ip = null, consent_user_agent = null, contact_name = null, contact_email = null, consent_text_version = 'x' where id = $1`,
          [old],
        ),
      ),
    ).toMatch(/no se editan/);
    const n = await notification(s, luis, 1);
    expect(await dbError(s.client.query(`update notifications set params = '{}' where id = $1`, [n]))).toMatch(/no admite UPDATE/);
    const oldN = await notification(s, luis, PII_RETENTION_DAYS + 5);
    expect(await dbError(s.client.query(`update notifications set params = '{}', dedupe_key = 'otra' where id = $1`, [oldN]))).toMatch(/no admite UPDATE/);
    expect(await dbError(s.client.query(`delete from notifications where id = $1`, [oldN]))).toMatch(/no admite DELETE/);
  });

  it("propiedad: tras la purga ningún código pasado de la retención conserva datos y ninguno reciente los pierde", { timeout: 120_000 }, async () => {
    const maria = await s.newClient("María Propiedad");
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 3 * PII_RETENTION_DAYS }), { minLength: 1, maxLength: 6 }), async (ages) => {
        const ids = await Promise.all(ages.map(async (days) => ({ days, id: await verification(s, maria, days + 0.01) })));
        await purgeExpiredPersonalData(s.db);
        for (const { days, id } of ids) {
          const row = await pii(s, id);
          if (days + 0.01 > PII_RETENTION_DAYS) expect(row).toEqual({ ip: null, ua: null, name: null, email: null });
          else expect(row.ip).toBe("203.0.113.7");
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe("auditoría de lecturas de contactos (Ley 1581)", () => {
  let s: Shop;
  beforeAll(async () => {
    s = await shop();
  }, 120_000);
  afterAll(async () => {
    await s?.client.close();
  });

  const count = async () => Number((await s.client.query<{ n: string }>(`select count(*)::text as n from personal_data_reads`)).rows[0]!.n);

  it("una fila por persona, pantalla y conjunto de clientes en la ventana; nada si no hay clientes", async () => {
    const a = await s.newClient("Lectura A");
    const b = await s.newClient("Lectura B");
    const now = new Date("2026-11-03T15:01:00Z");
    const base = await count();
    await recordContactReads(s.db, { locationId: s.locationId, staffId: s.staffId, context: "agenda_day", clientIds: [a, b], now });
    await recordContactReads(s.db, { locationId: s.locationId, staffId: s.staffId, context: "agenda_day", clientIds: [b, a, a], now });
    expect(await count()).toBe(base + 1);
    await recordContactReads(s.db, { locationId: s.locationId, staffId: s.staffId, context: "client_search", clientIds: [a], now });
    await recordContactReads(s.db, { locationId: s.locationId, staffId: s.staffId, context: "agenda_day", clientIds: [a, b], now: new Date(now.getTime() + 11 * 60_000) });
    await recordContactReads(s.db, { locationId: s.locationId, staffId: s.staffId, context: "agenda_day", clientIds: [], now });
    expect(await count()).toBe(base + 3);
  });

  it("es solo-inserción; se borra solo pasada su retención (y lo hace la purga)", async () => {
    const c = await s.newClient("Lectura C");
    await recordContactReads(s.db, { locationId: s.locationId, staffId: s.staffId, context: "client_search", clientIds: [c] });
    expect(await dbError(s.client.query(`update personal_data_reads set context = 'agenda_day'`))).toMatch(/no admite UPDATE/);
    expect(await dbError(s.client.query(`delete from personal_data_reads`))).toMatch(/no admite DELETE dentro de su retención/);
    expect(await dbError(s.client.query(`truncate personal_data_reads`))).toMatch(/no admite TRUNCATE/);
    await s.client.query(
      `insert into personal_data_reads (location_id, staff_id, context, client_ids, clients_hash, window_start, created_at)
       values ($1, $2, 'client_search', array[$3::bigint], $4, now() - interval '400 days', now() - interval '400 days')`,
      [String(s.locationId), String(s.staffId), String(c), HEX("d")],
    );
    const before = await count();
    expect((await purgeExpiredPersonalData(s.db)).reads).toBe(1);
    expect(await count()).toBe(before - 1);
  });
});

describe("como villa_app (el rol del worker en el VPS)", () => {
  let s: Shop;
  beforeAll(async () => {
    s = await shop("app");
  }, 120_000);
  afterAll(async () => {
    await s?.client.close();
  });

  it("la purga es SECURITY DEFINER de villa_owner, con search_path fijo y EXECUTE solo para villa_app", async () => {
    const { rows } = await s.client.query<{ owner: string; secdef: boolean; config: string[]; app: boolean; pub: boolean }>(
      `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, p.proconfig as config,
              has_function_privilege('villa_app', p.oid, 'EXECUTE') as app,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
         from pg_proc p where p.oid = 'public.purge_expired_personal_data()'::regprocedure`,
    );
    expect(rows[0]).toMatchObject({ owner: "villa_owner", secdef: true, app: true, pub: false });
    expect(rows[0]!.config).toContain("search_path=pg_catalog, public, pg_temp");
  });

  it("purga como villa_app aunque no tenga UPDATE sobre notifications", async () => {
    const juan = await s.newClient("Juan App");
    const v = await verification(s, juan, PII_RETENTION_DAYS + 2);
    const n = await notification(s, juan, PII_RETENTION_DAYS + 2);
    expect(await dbError(s.client.query(`update notifications set params = '{}' where id = $1`, [n]))).toMatch(/permission denied|permiso denegado/);
    const result = await purgeExpiredPersonalData(s.db);
    expect(result).toMatchObject({ verifications: 1, notifications: 1 });
    expect(await pii(s, v)).toEqual({ ip: null, ua: null, name: null, email: null });
    expect(await params(s, n)).toEqual({});
  });

  it("registra lecturas, pero no las borra ni las edita", async () => {
    const c = await s.newClient("Lectura App");
    await recordContactReads(s.db, { locationId: s.locationId, staffId: s.staffId, context: "client_search", clientIds: [c] });
    expect(await dbError(s.client.query(`delete from personal_data_reads`))).toMatch(/permission denied|permiso denegado/);
    expect(await dbError(s.client.query(`update personal_data_reads set context = 'agenda_day'`))).toMatch(/permission denied|permiso denegado/);
  });

  it("el bloqueo encola el aviso al dueño; el worker lo entrega una vez por ventana y lo marca", { timeout: 60_000 }, async () => {
    // Valor de prueba: solo existe en esta base en memoria.
    const owner = await createStaffUser(s.db, { locationId: s.locationId, name: "Cuenta Dueña", email: "duena@villa.test", password: "navaja-y-cuero-2026", role: "owner" });
    const subject = userThrottleSubject("reauth", owner.userId);
    const target = { subject, kind: "reauth" as const, account: { userId: owner.userId } };
    const t0 = new Date("2026-11-03T15:00:00Z");
    for (let i = 0; i < 5; i++) await reserveAttempt(s.db, [target], new Date(t0.getTime() + i * 1000));
    // Un bloqueo de un correo que no es del equipo: sin cuenta, sin correo guardado.
    for (let i = 0; i < 5; i++) {
      await reserveAttempt(s.db, [{ subject: "e".repeat(64), kind: "login", account: { email: "nadie@example.test" } }], new Date(t0.getTime() + i * 1000));
    }
    const pending = await pendingSecurityAlerts(s.db);
    expect(pending.map((p) => [p.throttleKind, p.userId])).toEqual([
      ["reauth", owner.userId],
      ["login", null],
    ]);
    const { rows } = await s.client.query<{ row: string }>(`select row_to_json(a)::text as row from security_alerts a`);
    expect(rows.map((r) => r.row).join()).not.toContain("nadie@example.test");

    const sent: { subject: string; text: string }[] = [];
    const send = async (subj: string, text: string) => {
      sent.push({ subject: subj, text });
    };
    const now = new Date("2026-11-03T15:05:00Z");
    expect(await deliverSecurityAlerts(s.db, send, { now })).toBe(2);
    expect(sent[0]!.subject).toBe("Villa: bloqueo de una cuenta del equipo por intentos fallidos");
    expect(sent[0]!.text).toContain("cuenta de Cuenta Dueña");
    expect(sent[0]!.text).toContain("1 bloqueo de correos que no son del equipo");
    expect(sent[0]!.text).not.toContain("nadie@example.test");
    expect(await pendingSecurityAlerts(s.db)).toEqual([]);

    // Otro bloqueo en la misma ventana de 15 minutos espera a la siguiente.
    for (let i = 0; i < 5; i++) await reserveAttempt(s.db, [{ subject: "f".repeat(64), kind: "login-ip" }], new Date(t0.getTime() + 60_000 + i));
    expect(await deliverSecurityAlerts(s.db, send, { now: new Date(now.getTime() + 60_000) })).toBe(0);
    expect(await deliverSecurityAlerts(s.db, send, { now: new Date(now.getTime() + 16 * 60_000) })).toBe(1);
    expect(sent).toHaveLength(2);

    // Ya entregados, se podan a los 90 días.
    expect(await pruneSecurityAlerts(s.db, new Date(now.getTime() + 91 * DAY_MS))).toBe(3);
  });

  it("un ataque desde muchas IP suma en una fila y el correo lo resume en una línea", { timeout: 60_000 }, async () => {
    // Valor de prueba: solo existe en esta base en memoria.
    const owner = await createStaffUser(s.db, { locationId: s.locationId, name: "Cuenta Flood", email: "flood@villa.test", password: "navaja-y-cuero-2026", role: "owner" });
    const at = new Date("2026-11-04T15:01:00Z");
    const lockedUntil = new Date(at.getTime() + 60_000);
    for (let i = 0; i < 500; i++) {
      await enqueueLockAlert(s.db, { kind: "login-ip", account: { email: `nadie${i}@example.test` }, failures: 5 + (i % 3), lockedUntil, now: at });
    }
    await enqueueLockAlert(s.db, { kind: "reauth", account: { userId: owner.userId }, failures: 5, lockedUntil, now: at });
    await enqueueLockAlert(s.db, { kind: "reauth", account: { userId: owner.userId }, failures: 6, lockedUntil, now: at });

    const { rows } = await s.client.query<{ user_id: string | null; occurrences: number; failures: number }>(
      `select user_id, occurrences, failures from security_alerts where window_start = '2026-11-04T15:00:00Z' order by occurrences`,
    );
    expect(rows).toEqual([
      { user_id: owner.userId, occurrences: 2, failures: 6 },
      { user_id: null, occurrences: 500, failures: 7 },
    ]);

    // Un aviso pendiente no se borra (ni siquiera con DELETE concedido a la app).
    expect(await dbError(s.client.query(`delete from security_alerts where notified_at is null`))).toMatch(/sin entregar/);

    const sent: { subject: string; text: string }[] = [];
    const delivered = await deliverSecurityAlerts(
      s.db,
      async (subject, text) => {
        sent.push({ subject, text });
      },
      { now: new Date(at.getTime() + 60_000) },
    );
    expect(delivered).toBe(2);
    expect(sent[0]!.text).toContain("500 bloqueos de correos que no son del equipo");
    // La cuenta del equipo va primero; los correos ajenos, en una sola línea y sin el correo.
    expect(sent[0]!.subject).toBe("Villa: bloqueo de una cuenta del equipo por intentos fallidos");
    expect(sent[0]!.text.indexOf("cuenta de Cuenta Flood")).toBeLessThan(sent[0]!.text.indexOf("500 bloqueos"));
    expect(sent[0]!.text).toContain("(2 veces)");
    expect(sent[0]!.text).not.toContain("nadie");

    // Una fila entregada no se reabre: el siguiente bloqueo de la misma ventana abre otra pendiente.
    await enqueueLockAlert(s.db, { kind: "login-ip", failures: 5, lockedUntil, now: at });
    expect(await pendingSecurityAlerts(s.db)).toHaveLength(1);
  });
});
