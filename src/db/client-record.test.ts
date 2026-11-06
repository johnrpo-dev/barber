import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURRENT_PRIVACY_VERSION } from "@/content/privacy/versions";
import { addDays, localMinuteToInstant, MINUTE_MS } from "@/domain/booking/clock";
import { DEVICE_PURGE_DAYS, MAX_ACTIVE_DEVICES } from "@/domain/clients/devices";
import { businessDate } from "@/domain/ledger/business-date";
import { changeStatus, createAppointment } from "./appointments";
import { clientDeviceSummary, forgetClientDevices, knownClient, purgeClientDevices, rememberClientDevice } from "./client-devices";
import { CLIENT_HISTORY_LIMIT, clientRecord } from "./client-record";
import { findOrCreateClient } from "./clients";
import { recordConsents, withdrawConsent } from "./consents";
import { purgeExpiredPersonalData } from "./privacy";
import { key, type Shop, setupShop, TZ } from "./sales-testing";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

// Ficha del cliente y privacidad (sprint 7): la ficha, retirar autorizaciones, olvidar navegadores,
// el tope de 5 navegadores y su purga. Corre como villa_app, como en el VPS.

let db: Db;
let client: PGlite;
let seq = 0;

beforeAll(async () => {
  ({ db, client } = await createTestDb({ role: "app" }));
}, 120_000);

afterAll(async () => {
  await client?.close();
});

const newShop = () => setupShop(db, `Ficha ${++seq}`);
const newClient = async (shop: Shop) =>
  (await findOrCreateClient(db, { locationId: shop.locationId, name: `Cliente ${++seq}`, phone: `311 ${String(1_000_000 + seq).slice(-7, -4)} ${String(1_000_000 + seq).slice(-4)}` })).id;
const rows = async <T>(text: string, params: unknown[] = []) => (await client.query<T>(text, params as never[])).rows;

async function appointment(shop: Shop, clientId: bigint, dayOffset: number, minute = 9 * 60, source: "staff" | "online" = "staff"): Promise<{ id: bigint; start: Date }> {
  const start = localMinuteToInstant(addDays(businessDate(new Date(), TZ), dayOffset), minute, TZ);
  const { appointmentId } = await createAppointment(db, {
    locationId: shop.locationId,
    serviceId: shop.service,
    staffId: shop.barber,
    start,
    clientId,
    source,
    idempotencyKey: key("ficha"),
    createdBy: source === "online" ? "online" : shop.owner.userId,
    ...(source === "staff" ? { allowOutsideHours: true } : {}),
  });
  return { id: appointmentId, start };
}

describe("ficha del cliente", () => {
  it("cuenta en SQL, trae las citas de la más reciente a la más vieja y no cruza sedes", async () => {
    const shop = await newShop();
    const c = await newClient(shop);
    const past = await appointment(shop, c, 3, 9 * 60);
    await changeStatus(db, { locationId: shop.locationId, appointmentId: past.id, to: "no_show", actor: shop.reception, now: new Date(past.start.getTime() + 60 * MINUTE_MS) });
    const cancelled = await appointment(shop, c, 4, 10 * 60);
    await changeStatus(db, { locationId: shop.locationId, appointmentId: cancelled.id, to: "cancelled", actor: shop.reception, cancelReason: "client" });
    await appointment(shop, c, 5, 11 * 60);
    await recordConsents(db, {
      locationId: shop.locationId,
      clientId: c,
      appointmentId: null,
      choices: { dataProcessing: true, reminders: true, marketing: false },
      textVersion: CURRENT_PRIVACY_VERSION,
      ip: null,
      userAgent: null,
      source: "online",
    });
    await rememberClientDevice(db, { locationId: shop.locationId, clientId: c, now: new Date() });

    const r = await clientRecord(db, { locationId: shop.locationId, clientId: c, now: new Date() });
    expect(r).not.toBeNull();
    expect(r!.counts).toEqual({ total: 3, completed: 0, noShows: 1, cancelled: 1, upcoming: 1 });
    expect(r!.history.map((h) => h.status)).toEqual(["confirmed", "cancelled", "no_show"]);
    expect(r!.history[0]!.staffName).toBe("Andrés");
    expect(r!.noShows).toMatchObject({ count: 1, suspended: false });
    expect(r!.consents.reminders).toMatchObject({ granted: true, textVersion: CURRENT_PRIVACY_VERSION, source: "online" });
    expect(r!.consents.marketing).toMatchObject({ granted: false });
    expect(r!.devices.active).toBe(1);

    const other = await newShop();
    expect(await clientRecord(db, { locationId: other.locationId, clientId: c, now: new Date() })).toBeNull();
  });

  it(`muestra las últimas ${CLIENT_HISTORY_LIMIT} citas; la reserva en línea sin confirmar (pending) no cuenta ni aparece`, { timeout: 60_000 }, async () => {
    const shop = await newShop();
    const c = await newClient(shop);
    const total = CLIENT_HISTORY_LIMIT + 2;
    const starts: Date[] = [];
    for (let d = 1; d <= total; d++) starts.push((await appointment(shop, c, d)).start);
    // La más lejana es una retención en línea: si contara, encabezaría el historial.
    const hold = await appointment(shop, c, total + 10, 9 * 60, "online");
    expect((await rows<{ status: string }>(`select status from appointments where id = $1`, [String(hold.id)]))[0]!.status).toBe("pending");

    const r = (await clientRecord(db, { locationId: shop.locationId, clientId: c, now: new Date() }))!;
    expect(r.counts.total).toBe(total);
    expect(r.counts.upcoming).toBe(total);
    expect(r.history).toHaveLength(CLIENT_HISTORY_LIMIT);
    expect(r.history.map((h) => h.status)).not.toContain("pending");
    expect(r.history.map((h) => h.id)).not.toContain(hold.id);
    expect(r.history.map((h) => h.start.getTime())).toEqual(starts.slice(-CLIENT_HISTORY_LIMIT).reverse().map((d) => d.getTime()));
  });
});

describe("retirar una autorización", () => {
  it("inserta un no del personal con la versión vigente y su evento; la base no deja editar la fila anterior", async () => {
    const shop = await newShop();
    const c = await newClient(shop);
    await recordConsents(db, {
      locationId: shop.locationId,
      clientId: c,
      appointmentId: null,
      choices: { dataProcessing: true, reminders: true, marketing: true },
      textVersion: "2026-11-03",
      ip: null,
      userAgent: null,
      source: "online",
    });
    await withdrawConsent(db, { locationId: shop.locationId, clientId: c, purpose: "marketing", actor: shop.reception });
    const consents = await rows<{ purpose: string; granted: boolean; v: string; source: string }>(
      `select purpose, granted, text_version as v, source from client_consents where client_id = $1 order by id`,
      [String(c)],
    );
    expect(consents.at(-1)).toEqual({ purpose: "marketing", granted: false, v: CURRENT_PRIVACY_VERSION, source: "staff" });
    expect(consents.filter((r) => r.purpose === "marketing")).toHaveLength(2);
    const events = await rows<{ action: string; category: string; target: string }>(
      `select action, category, target_ref as target from audit_events where location_id = $1 and action = 'client.consent_withdraw'`,
      [String(shop.locationId)],
    );
    expect(events).toEqual([{ action: "client.consent_withdraw", category: "personal", target: String(c) }]);
    expect(await dbError(client.query(`update client_consents set granted = true where client_id = $1`, [String(c)]))).toMatch(/permission denied|permiso denegado/);
  });

  it("otra sede o un cliente sin esa autorización: no escribe nada", async () => {
    const shop = await newShop();
    const c = await newClient(shop);
    const other = await newShop();
    await expect(withdrawConsent(db, { locationId: other.locationId, clientId: c, purpose: "reminders", actor: other.reception })).rejects.toThrow("no existe");
    await expect(withdrawConsent(db, { locationId: shop.locationId, clientId: c, purpose: "reminders", actor: shop.reception })).rejects.toThrow("vigente");
    await expect(withdrawConsent(db, { locationId: shop.locationId, clientId: c, purpose: "data_processing" as never, actor: shop.reception })).rejects.toThrow();
    expect(await rows(`select 1 from client_consents where client_id = $1`, [String(c)])).toEqual([]);
    expect(await rows(`select 1 from audit_events where target_ref = $1 and action = 'client.consent_withdraw'`, [String(c)])).toEqual([]);
  });
});

describe("navegadores recordados", () => {
  it("olvidarlos revoca todos los activos con un evento; revocar es definitivo", async () => {
    const shop = await newShop();
    const c = await newClient(shop);
    const now = new Date();
    const tokens = [await rememberClientDevice(db, { locationId: shop.locationId, clientId: c, now }), await rememberClientDevice(db, { locationId: shop.locationId, clientId: c, now })];
    const other = await newShop();
    await expect(forgetClientDevices(db, { locationId: other.locationId, clientId: c, actor: other.reception, now })).rejects.toThrow("no existe");
    expect(await forgetClientDevices(db, { locationId: shop.locationId, clientId: c, actor: shop.reception, now })).toBe(2);
    for (const token of tokens) expect(await knownClient(db, { locationId: shop.locationId, token, now })).toBeNull();
    expect(await clientDeviceSummary(db, { locationId: shop.locationId, clientId: c, now })).toEqual({ active: 0, lastUsedAt: null });
    await expect(forgetClientDevices(db, { locationId: shop.locationId, clientId: c, actor: shop.reception, now })).rejects.toThrow("no tiene navegadores");
    const events = await rows<{ summary: string }>(`select summary from audit_events where target_ref = $1 and action = 'client.devices_forget'`, [String(c)]);
    expect(events).toEqual([{ summary: "Olvidó 2 navegadores recordados de un cliente" }]);
    expect(await dbError(client.query(`update client_devices set revoked_at = null where client_id = $1`, [String(c)]))).toMatch(/ya fue revocado/);
  });

  it(`al recordar el sexto se revoca el de uso más viejo; uno viejo pero usado hace poco sigue`, async () => {
    const shop = await newShop();
    const c = await newClient(shop);
    const now = new Date();
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_DEVICES; i++) {
      const token = await rememberClientDevice(db, { locationId: shop.locationId, clientId: c, now });
      ids.push((await knownClient(db, { locationId: shop.locationId, token, now }))!.deviceId.toString());
    }
    // El primero se usó después de recordar los demás (un segundo después, para no empatar en el reloj).
    await client.query(`update client_devices set last_used_at = now() + interval '1 second' where id = $1`, [ids[0]]);
    await rememberClientDevice(db, { locationId: shop.locationId, clientId: c, now });
    const state = await rows<{ id: string; revoked: boolean }>(
      `select id::text, revoked_at is not null as revoked from client_devices where client_id = $1 order by id`,
      [String(c)],
    );
    expect(state.filter((d) => d.revoked).map((d) => d.id)).toEqual([ids[1]]);
    expect(state.find((d) => d.id === ids[0])!.revoked).toBe(false);
    expect(state.filter((d) => !d.revoked)).toHaveLength(MAX_ACTIVE_DEVICES);
  });

  it(`propiedad: tras cualquier número de verificaciones quedan como máximo ${MAX_ACTIVE_DEVICES} activos, el último siempre sirve y los revocados son los de uso más viejo`, { timeout: 120_000 }, async () => {
    const shop = await newShop();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 9 }), fc.array(fc.nat({ max: 8 }), { maxLength: 4 }), async (n, touches) => {
        const c = await newClient(shop);
        const now = new Date();
        const tokens: string[] = [];
        for (let i = 0; i < n; i++) {
          tokens.push(await rememberClientDevice(db, { locationId: shop.locationId, clientId: c, now }));
          // Algunos se usan después de recordados: el tope revoca primero los de uso más viejo.
          for (const t of touches.filter((t) => t < tokens.length)) {
            const k = await knownClient(db, { locationId: shop.locationId, token: tokens[t]!, now });
            if (k) await client.query(`update client_devices set last_used_at = now() where id = $1`, [String(k.deviceId)]);
          }
          const summary = await clientDeviceSummary(db, { locationId: shop.locationId, clientId: c, now });
          expect(summary.active).toBe(Math.min(i + 1, MAX_ACTIVE_DEVICES));
          expect(await knownClient(db, { locationId: shop.locationId, token: tokens.at(-1)!, now })).not.toBeNull();
          // Ningún activo tiene un uso más viejo que un revocado (empates por id, como devicesToRevoke;
          // al milisegundo, como lo compara la aplicación).
          const inverted = await rows<{ n: number }>(
            `select count(*)::int as n
               from client_devices a
               join client_devices r on r.location_id = a.location_id and r.client_id = a.client_id
              where a.client_id = $1 and a.revoked_at is null and r.revoked_at is not null
                and (date_trunc('milliseconds', coalesce(a.last_used_at, a.created_at)), a.id)
                  < (date_trunc('milliseconds', coalesce(r.last_used_at, r.created_at)), r.id)`,
            [String(c)],
          );
          expect(inverted[0]!.n).toBe(0);
        }
      }),
      { numRuns: 12 },
    );
  });

  it(`la purga borra los revocados o vencidos hace más de ${DEVICE_PURGE_DAYS} días; la base no deja borrar nada más`, async () => {
    const shop = await newShop();
    const c = await newClient(shop);
    const hex = (ch: string) => ch.repeat(64);
    const insert = async (h: string, expiresDaysAgo: number) =>
      (
        await rows<{ id: string }>(
          `insert into client_devices (location_id, client_id, token_hash, expires_at) values ($1, $2, $3, now() - make_interval(days => $4)) returning id::text`,
          [String(shop.locationId), String(c), h, expiresDaysAgo],
        )
      )[0]!.id;
    const expiredOld = await insert(hex("1"), DEVICE_PURGE_DAYS + 1);
    const expiredRecent = await insert(hex("2"), DEVICE_PURGE_DAYS - 1);
    const revokedOld = await insert(hex("3"), -100);
    const revokedRecent = await insert(hex("4"), -100);
    const active = await insert(hex("5"), -100);
    await client.query(`update client_devices set revoked_at = now() - make_interval(days => $2) where id = $1`, [revokedOld, DEVICE_PURGE_DAYS + 1]);
    await client.query(`update client_devices set revoked_at = now() - make_interval(days => $2) where id = $1`, [revokedRecent, DEVICE_PURGE_DAYS - 1]);

    // Con la app tomada, borrar algo vivo o reciente lo frena el trigger, y vaciar la tabla no se puede.
    for (const id of [active, revokedRecent, expiredRecent]) {
      expect(await dbError(client.query(`delete from client_devices where id = $1`, [id]))).toMatch(/sigue activo o dejó de servir hace menos/);
    }
    expect(await dbError(client.query(`truncate client_devices`))).toMatch(/permission denied|permiso denegado|no admite/);

    expect(await purgeClientDevices(db)).toBe(2);
    const left = (await rows<{ id: string }>(`select id::text from client_devices where client_id = $1`, [String(c)])).map((r) => r.id);
    expect(left.sort()).toEqual([expiredRecent, revokedRecent, active].sort());
    expect(left).not.toContain(expiredOld);
    expect(left).not.toContain(revokedOld);
    // El mantenimiento diario la corre con el resto de la purga.
    expect(await purgeExpiredPersonalData(db)).toMatchObject({ devices: 0 });
  });
});
