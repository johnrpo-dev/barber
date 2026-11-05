import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { changeStatus, createAppointment } from "./appointments";
import { clientErasePreview, eraseClient, findOrCreateClient } from "./clients";
import { checkout } from "./sales";
import { chairAppointment, key, type Shop, setupShop, simpleCheckout, TZ } from "./sales-testing";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";
import { decideVoid, requestVoid } from "./voids";
import { openCashSession } from "./cash";
import { fromUnits, money } from "@/domain/money";
import { updateCheckoutRules } from "./checkout-settings";

// Supresión a solicitud del titular (docs/sprint-5-comisiones-informes.md §12.8): los datos
// personales salen de todas partes y lo contable no cambia en un solo centavo. Corre como villa_app,
// como en el VPS: la app solo llega a esas columnas por la función de la base.

const HEX = (c: string) => c.repeat(64);
const SECRET = "Juan Pérez, cel 300 123 4567";

let db: Db;
let client: PGlite;
let seq = 0;

beforeAll(async () => {
  ({ db, client } = await createTestDb({ role: "app" }));
}, 120_000);

afterAll(async () => {
  await client?.close();
});

const actor = (shop: Shop) => ({ userId: shop.owner.userId, staffId: shop.owner.staffId });
const erase = (shop: Shop, clientId = shop.client) => eraseClient(db, { locationId: shop.locationId, clientId, actor: actor(shop) });
const one = async <T>(text: string, params: unknown[] = []) => (await client.query<T>(text, params as never[])).rows[0]!;
const newShop = () => setupShop(db, `Supresión ${++seq}`);

/** Una cita ya cancelada con nota. */
async function cancelledAppointment(shop: Shop, clientId = shop.client): Promise<bigint> {
  const { appointmentId } = await createAppointment(db, {
    locationId: shop.locationId,
    serviceId: shop.service,
    staffId: shop.barber2,
    start: localMinuteToInstant(addDays(businessDate(new Date(), TZ), 30 + ++seq), 8 * 60, TZ),
    clientId,
    source: "staff",
    notes: `Nota: ${SECRET}`,
    idempotencyKey: key("appt"),
    createdBy: shop.owner.userId,
  });
  await changeStatus(db, { locationId: shop.locationId, appointmentId, to: "cancelled", cancelReason: "staff", note: `Canceló ${SECRET}`, actor: shop.owner } as never);
  return appointmentId;
}

/** Fotos de todo lo contable: si cambia un byte, la supresión tocó lo que no debía. */
async function financialSnapshot(shop: Shop): Promise<string> {
  const loc = String(shop.locationId);
  const parts: string[] = [];
  for (const table of ["journal_entries", "journal_lines", "sales", "sale_lines", "sale_payments", "sale_tips", "cash_sessions", "expenses"]) {
    const { rows } = await client.query<{ row: string }>(`select row(t.*)::text as row from ${table} t where t.location_id = $1 order by t.id`, [loc]);
    parts.push(`${table}:${rows.map((r) => r.row).join("|")}`);
  }
  const { rows } = await client.query<{ row: string }>(`select id::text || ':' || kind || ':' || journal_entry_id::text as row from cash_movements where location_id = $1 order by id`, [loc]);
  parts.push(`moves:${rows.map((r) => r.row).join("|")}`);
  return parts.join("\n");
}

describe("suprimir los datos de un cliente", () => {
  it("borra lo personal de todas las tablas, deja el evento sin datos y no toca nada contable", { timeout: 120_000 }, async () => {
    const shop = await newShop();
    await openCashSession(db, { locationId: shop.locationId, counted: fromUnits(0n), idempotencyKey: key("open"), actor: shop.owner });
    const appointmentId = await chairAppointment(db, shop);
    const { saleId } = await checkout(db, simpleCheckout(shop, appointmentId, { kind: "cash" }));
    const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId, reason: `Lo pidió ${SECRET}`, idempotencyKey: key("void"), actor: shop.reception });
    await decideVoid(db, { locationId: shop.locationId, requestId, approve: true, note: `Aprobada por ${SECRET}`, idempotencyKey: key("decide"), approver: shop.owner });
    const cancelled = await cancelledAppointment(shop);

    const loc = String(shop.locationId);
    const cli = String(shop.client);
    const appt = String(cancelled);
    await client.query(
      `insert into booking_verifications (location_id, appointment_id, client_id, channel, code_hash, browser_hash, expires_at, superseded_at,
         consent_choices, consent_text_version, consent_ip, consent_user_agent, contact_name, contact_email)
       values ($1, $2, $3, 'whatsapp', $4, $5, now(), now(), '{"dataProcessing":true,"reminders":false,"marketing":false}', '2026-11-01',
               '203.0.113.7', 'Mozilla', 'Juan', 'juan@example.test')`,
      [loc, appt, cli, HEX("a"), HEX("b")],
    );
    await client.query(`insert into client_consents (location_id, client_id, appointment_id, purpose, granted, text_version, ip, user_agent, source)
       values ($1, $2, $3, 'data_processing', true, '2026-11-01', '203.0.113.7', 'Mozilla', 'online')`, [loc, cli, appt]);
    const notification = await client.query<{ id: string }>(
      `insert into notifications (location_id, appointment_id, client_id, channel, template, recipient_hash, dedupe_key, send_after, params)
       values ($1, $2, $3, 'whatsapp', 'booking_confirmed', $4, $5, now(), '{"name":"Juan"}') returning id::text`,
      [loc, appt, cli, HEX("c"), `erase:${key()}`],
    );
    await client.query(`insert into notification_events (location_id, notification_id, kind, error_detail) values ($1, $2, 'failed', $3)`, [loc, notification.rows[0]!.id, `Falló para ${SECRET}`]);
    await client.query(`insert into appointment_links (location_id, appointment_id, token_hash, generation, expires_at) values ($1, $2, $3, 0, now() + interval '30 days')`, [loc, appt, HEX("d")]);

    const ledgerBefore = await financialSnapshot(shop);
    await erase(shop);

    expect(await one(`select name, phone_e164, email, anonymized_at is not null as anonymized from clients where id = $1`, [cli])).toEqual({ name: "Anónimo", phone_e164: null, email: null, anonymized: true });
    expect(await financialSnapshot(shop)).toBe(ledgerBefore);
    expect(await one(`select client_id::text as c from sales where id = $1`, [String(saleId)])).toEqual({ c: cli });

    expect(await one(`select notes, cancel_note from appointments where id = $1`, [appt])).toEqual({ notes: null, cancel_note: null });
    expect(await one(`select count(*)::int as n from appointment_events e join appointments a on a.id = e.appointment_id where a.client_id = $1 and e.reason is not null`, [cli])).toEqual({ n: 0 });
    expect(await one(`select consent_ip, consent_user_agent, contact_name, contact_email from booking_verifications where client_id = $1`, [cli])).toEqual({
      consent_ip: null,
      consent_user_agent: null,
      contact_name: null,
      contact_email: null,
    });
    expect(await one(`select ip, user_agent, granted, text_version from client_consents where client_id = $1`, [cli])).toEqual({ ip: null, user_agent: null, granted: true, text_version: "2026-11-01" });
    expect(await one(`select params from notifications where client_id = $1`, [cli])).toEqual({ params: {} });
    expect(await one(`select error_detail, kind from notification_events where notification_id = $1`, [notification.rows[0]!.id])).toEqual({ error_detail: null, kind: "failed" });
    expect(await one(`select reason, decision_note from void_requests where id = $1`, [String(requestId)])).toEqual({ reason: "[suprimido]", decision_note: "[suprimido]" });
    expect(await one(`select count(*)::int as n from cash_movements where location_id = $1 and description like '%Juan%'`, [loc])).toEqual({ n: 0 });
    expect(await one(`select count(*)::int as n from appointment_links l join appointments a on a.id = l.appointment_id where a.client_id = $1 and l.revoked_at is null`, [cli])).toEqual({ n: 0 });

    // El libro nunca recibió el motivo.
    expect(await one(`select count(*)::int as n from journal_entries where location_id = $1 and memo like '%Juan%'`, [loc])).toEqual({ n: 0 });

    const event = await one<{ action: string; category: string; target_kind: string; target_ref: string; row: string }>(
      `select action, category, target_kind, target_ref, row(a.*)::text as row from audit_events a where location_id = $1 and action = 'client.erase'`,
      [loc],
    );
    expect(event).toMatchObject({ action: "client.erase", category: "personal", target_kind: "client", target_ref: cli });
    for (const personal of ["Juan", "Pérez", "300", "3001234567"]) expect(event.row).not.toContain(personal);
  });

  it("con citas activas se rechaza y no cambia nada; otra vez, ya suprimido; otra sede no lo alcanza", { timeout: 120_000 }, async () => {
    const shop = await newShop();
    const appointmentId = await chairAppointment(db, shop);
    await expect(erase(shop)).rejects.toThrow(/citas activas/);
    expect(await one(`select name from clients where id = $1`, [String(shop.client)])).toEqual({ name: "Juan Pérez" });
    expect(await clientErasePreview(db, { locationId: shop.locationId, clientId: shop.client })).toMatchObject({ activeAppointments: 1, appointments: 1, sales: 0 });

    await changeStatus(db, { locationId: shop.locationId, appointmentId, to: "completed", actor: shop.owner });
    const other = await newShop();
    await expect(eraseClient(db, { locationId: other.locationId, clientId: shop.client, actor: actor(other) })).rejects.toThrow(/no existe/);
    await erase(shop);
    await expect(erase(shop)).rejects.toThrow(/ya se suprimieron/);
    expect(await clientErasePreview(db, { locationId: shop.locationId, clientId: shop.client })).toBeNull();
    expect(await one(`select count(*)::int as n from audit_events where location_id = $1 and action = 'client.erase'`, [String(shop.locationId)])).toEqual({ n: 1 });
  });

  it("la app no llega a esas columnas sin la función", { timeout: 120_000 }, async () => {
    const shop = await newShop();
    const cancelled = await cancelledAppointment(shop);
    const { rows } = await client.query<{ id: string }>(`select id::text from appointment_events where appointment_id = $1 limit 1`, [String(cancelled)]);
    expect(await dbError(client.query(`update appointment_events set reason = null where id = $1`, [rows[0]!.id]))).toMatch(/permission denied|permiso denegado/);
    expect(await dbError(client.query(`update void_requests set reason = 'x' where location_id = $1`, [String(shop.locationId)]))).toMatch(/permission denied|permiso denegado/);
    expect(await dbError(client.query(`update cash_movements set description = 'x' where location_id = $1`, [String(shop.locationId)]))).toMatch(/permission denied|permiso denegado/);
  });

  it("borra el motivo del descuento y olvida los dispositivos recordados, sin tocar un peso", { timeout: 120_000 }, async () => {
    const shop = await newShop();
    await updateCheckoutRules(db, shop.locationId, { commissionBase: "net", maxDiscountBps: 3_000n, receptionCanDiscount: true, tipsBearCardFees: false });
    const appointmentId = await chairAppointment(db, shop);
    const { saleId } = await checkout(db, {
      ...simpleCheckout(shop, appointmentId),
      discounts: [{ key: "appointment", amount: fromUnits(3_000n), reason: `Amigo de ${SECRET}` }],
      payments: [{ methodId: shop.methods.card, amount: money(fromUnits(27_000n).minor) }],
    });
    const loc = String(shop.locationId);
    const cli = String(shop.client);
    await client.query(`insert into client_devices (location_id, client_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '180 days')`, [loc, cli, HEX("e")]);
    const amounts = `select unit_price::text, discount::text, net::text, commission::text from sale_lines where sale_id = $1`;
    const before = await one(amounts, [String(saleId)]);

    await erase(shop);

    expect(await one(`select discount_reason from sale_lines where sale_id = $1`, [String(saleId)])).toEqual({ discount_reason: "[suprimido]" });
    expect(await one(amounts, [String(saleId)])).toEqual(before);
    expect(await one(`select count(*)::int as n from client_devices where client_id = $1 and revoked_at is null`, [cli])).toEqual({ n: 0 });
  });

  it("sale_lines: sobre un cliente vigente sigue cerrada; anonimizado, solo pasa el vaciado exacto del motivo", { timeout: 120_000 }, async () => {
    const app = { db, client };
    ({ db, client } = await createTestDb());
    try {
      const shop = await newShop();
      await updateCheckoutRules(db, shop.locationId, { commissionBase: "net", maxDiscountBps: 3_000n, receptionCanDiscount: true, tipsBearCardFees: false });
      const appointmentId = await chairAppointment(db, shop);
      const { saleId } = await checkout(db, {
        ...simpleCheckout(shop, appointmentId),
        discounts: [{ key: "appointment", amount: fromUnits(3_000n), reason: "Cliente frecuente" }],
        payments: [{ methodId: shop.methods.card, amount: money(fromUnits(27_000n).minor) }],
      });
      const sale = String(saleId);
      expect(await dbError(client.query(`update sale_lines set discount_reason = '[suprimido]' where sale_id = $1`, [sale]))).toMatch(/no admite UPDATE/);
      await client.query(`update clients set anonymized_at = now() where id = $1`, [String(shop.client)]);
      expect(await dbError(client.query(`update sale_lines set discount_reason = 'otro' where sale_id = $1`, [sale]))).toMatch(/no admite UPDATE/);
      expect(await dbError(client.query(`update sale_lines set discount_reason = '[suprimido]', net = net + 100 where sale_id = $1`, [sale]))).toMatch(/no admite UPDATE/);
      await client.query(`update sale_lines set discount_reason = '[suprimido]' where sale_id = $1`, [sale]);
      expect(await dbError(client.query(`delete from sale_lines where sale_id = $1`, [sale]))).toMatch(/no admite DELETE/);
    } finally {
      await client.close();
      ({ db, client } = app);
    }
  });

  it("los triggers: sobre un cliente vigente todo sigue cerrado; anonimizado, solo pasa el vaciado exacto", { timeout: 120_000 }, async () => {
    // Como superusuario (una base aparte): lo que se prueba es el trigger, no el permiso.
    const app = { db, client };
    ({ db, client } = await createTestDb());
    try {
      const shop = await newShop();
      const cancelled = await cancelledAppointment(shop);
      const { rows } = await client.query<{ id: string }>(`select id::text from appointment_events where appointment_id = $1 limit 1`, [String(cancelled)]);
      expect(await dbError(client.query(`update appointment_events set reason = null where id = $1`, [rows[0]!.id]))).toMatch(/no admite UPDATE/);
      expect(await dbError(client.query(`update appointments set notes = null where id = $1`, [String(cancelled)]))).toMatch(/ya no se modifica/);
      expect(await dbError(client.query(`delete from appointment_events where id = $1`, [rows[0]!.id]))).toMatch(/no admite DELETE/);
      await client.query(`update clients set anonymized_at = now() where id = $1`, [String(shop.client)]);
      expect(await dbError(client.query(`update appointment_events set reason = 'otra' where id = $1`, [rows[0]!.id]))).toMatch(/no admite UPDATE/);
      expect(await dbError(client.query(`update appointments set notes = null, price = price + 1 where id = $1`, [String(cancelled)]))).toMatch(/ya no se modifica/);
    } finally {
      await client.close();
      ({ db, client } = app);
    }
  });

  it("la función es SECURITY DEFINER de villa_owner, con search_path fijo y EXECUTE solo para villa_app", async () => {
    const row = await one<{ owner: string; secdef: boolean; config: string[]; app: boolean; pub: boolean }>(
      `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, p.proconfig as config,
              has_function_privilege('villa_app', p.oid, 'EXECUTE') as app,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
         from pg_proc p where p.oid = 'public.erase_client_personal_data(bigint, bigint)'::regprocedure`,
    );
    expect(row).toMatchObject({ owner: "villa_owner", secdef: true, app: true, pub: false });
    expect(row.config).toContain("search_path=pg_catalog, public, pg_temp");
  });

  it("se puede volver a aplicar (tras restaurar una copia) sin efectos nuevos", async () => {
    const shop = await newShop();
    await erase(shop);
    const before = await financialSnapshot(shop);
    await client.query(`select erase_client_personal_data($1, $2)`, [String(shop.locationId), String(shop.client)]);
    expect(await financialSnapshot(shop)).toBe(before);
    expect(await one(`select name from clients where id = $1`, [String(shop.client)])).toEqual({ name: "Anónimo" });
  });

  it("propiedad: con cualquier historia de ventas y anulaciones, suprimir no cambia ningún saldo del libro", { timeout: 300_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ cash: fc.boolean(), tip: fc.constantFrom(0n, 1_000n, 2_500n), voided: fc.boolean(), other: fc.boolean() }), { minLength: 1, maxLength: 5 }),
        async (history) => {
          const shop = await newShop();
          await openCashSession(db, { locationId: shop.locationId, counted: fromUnits(0n), idempotencyKey: key("open"), actor: shop.owner });
          const stranger = (await findOrCreateClient(db, { locationId: shop.locationId, name: "Otra Persona", phone: `310 000 ${String(++seq).padStart(4, "0")}` })).id;
          for (const h of history) {
            const appointmentId = await chairAppointment(db, shop);
            const { saleId } = await checkout(db, simpleCheckout(shop, appointmentId, { kind: h.cash ? "cash" : "card", tip: h.tip }));
            if (h.voided) {
              const { requestId } = await requestVoid(db, { locationId: shop.locationId, saleId, reason: `Motivo con ${SECRET}`, idempotencyKey: key("void"), actor: shop.reception });
              await decideVoid(db, { locationId: shop.locationId, requestId, approve: true, note: "", idempotencyKey: key("decide"), approver: shop.owner });
            }
          }
          const balances = () =>
            client.query(
              `select a.code, coalesce(sum(l.debit), 0)::text as d, coalesce(sum(l.credit), 0)::text as c
                 from accounts a left join journal_lines l on l.location_id = a.location_id and l.account_id = a.id
                where a.location_id = $1 group by a.code order by a.code`,
              [String(shop.locationId)],
            );
          const before = (await balances()).rows;
          const snapshot = await financialSnapshot(shop);
          await erase(shop, history[0]!.other ? stranger : shop.client).catch((e: Error) => {
            // Las citas de la historia se cobraron, pero siguen en silla si el cobro no las termina.
            if (!/citas activas/.test(e.message)) throw e;
          });
          expect((await balances()).rows).toEqual(before);
          expect(await financialSnapshot(shop)).toBe(snapshot);
        },
      ),
      { numRuns: 8 },
    );
  });
});
