import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { createAppointment } from "./appointments";
import { createService } from "./catalog";
import { findOrCreateClient } from "./clients";
import { createLocation } from "./ledger";
import { addStaffMember, setWeeklySchedule } from "./staff";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

// Garantías de la migración public_booking_guards (0007), probadas contra Postgres: aunque la
// app tenga un error, un código no se consume vencido ni dos veces, los intentos solo suben de
// a uno, y el outbox, sus eventos y los consentimientos son solo-inserción.

const TZ = "America/Bogota";
const HEX = (c: string) => c.repeat(64);

let db: Db;
let client: PGlite;
let location: bigint;
let clientId: bigint;
let appointmentId: bigint;

async function verification(opts: { expiresInSec: number; attempts?: number }): Promise<bigint> {
  const rows = await client.query<{ id: string }>(
    `insert into booking_verifications
       (location_id, appointment_id, client_id, channel, code_hash, browser_hash, attempts, expires_at, consent_choices, consent_text_version)
     values ($1, $2, $3, 'whatsapp', $4, $5, $6, now() + make_interval(secs => $7), '{"dataProcessing":true,"reminders":false,"marketing":false}', '2026-11-01')
     returning id::text`,
    [String(location), String(appointmentId), String(clientId), HEX("a"), HEX("b"), opts.attempts ?? 0, opts.expiresInSec],
  );
  // Las filas vivas se reemplazan para no chocar con "una viva por cita".
  return BigInt(rows.rows[0]!.id);
}

async function supersedeAll() {
  await client.query(`update booking_verifications set superseded_at = now() where consumed_at is null and superseded_at is null`);
}

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  location = await createLocation(db, { name: "Villa" });
  const barber = await addStaffMember(db, { locationId: location, displayName: "Barbero", role: "barber" });
  await setWeeklySchedule(db, {
    locationId: location,
    staffId: barber,
    blocks: ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: 0, endMin: 1440 })),
  });
  const service = await createService(db, {
    locationId: location,
    draft: { name: "Corte", durationMin: 30, bufferMin: 0, price: fromUnits(30_000n), commissionBps: 4_000 },
  });
  clientId = (await findOrCreateClient(db, { locationId: location, name: "Ana", phone: "300 111 2233" })).id;
  const date = addDays(businessDate(new Date(), TZ), 2);
  appointmentId = (
    await createAppointment(db, {
      locationId: location,
      serviceId: service.id,
      staffId: barber,
      start: localMinuteToInstant(date, 600, TZ),
      clientId,
      source: "online",
      idempotencyKey: "guards-1",
      createdBy: "online",
    })
  ).appointmentId;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("booking_verifications", () => {
  it("un código vencido no se puede consumir con un UPDATE directo", async () => {
    await supersedeAll();
    const id = await verification({ expiresInSec: -60, attempts: 1 });
    expect(await dbError(db.execute(sql`update booking_verifications set consumed_at = now() where id = ${String(id)}::bigint`))).toMatch(/no se puede consumir/);
  });

  it("los intentos solo suben de uno en uno y nunca después del máximo", async () => {
    await supersedeAll();
    const id = await verification({ expiresInSec: 300 });
    expect(await dbError(db.execute(sql`update booking_verifications set attempts = attempts + 2 where id = ${String(id)}::bigint`))).toMatch(/de uno en uno/);
    expect(await dbError(db.execute(sql`update booking_verifications set attempts = attempts - 1 where id = ${String(id)}::bigint`))).toMatch(/de uno en uno/);
    await supersedeAll();
    const locked = await verification({ expiresInSec: 300, attempts: 5 });
    expect(await dbError(db.execute(sql`update booking_verifications set attempts = attempts + 1 where id = ${String(locked)}::bigint`))).toMatch(/intentos/);
  });

  it("se consume una sola vez y después queda congelado", async () => {
    await supersedeAll();
    const id = await verification({ expiresInSec: 300, attempts: 1 });
    await db.execute(sql`update booking_verifications set consumed_at = now() where id = ${String(id)}::bigint`);
    expect(await dbError(db.execute(sql`update booking_verifications set consumed_at = now() + interval '1 second' where id = ${String(id)}::bigint`))).toMatch(
      /ya se usó/,
    );
  });

  it("sin intentos contados no se consume, y el hash y la evidencia no se editan", async () => {
    await supersedeAll();
    const id = await verification({ expiresInSec: 300 });
    expect(await dbError(db.execute(sql`update booking_verifications set consumed_at = now() where id = ${String(id)}::bigint`))).toMatch(/no se puede consumir/);
    expect(await dbError(db.execute(sql`update booking_verifications set code_hash = ${HEX("c")} where id = ${String(id)}::bigint`))).toMatch(/no se editan/);
    expect(await dbError(db.execute(sql`update booking_verifications set consent_ip = '1.1.1.1' where id = ${String(id)}::bigint`))).toMatch(/no se editan/);
  });

  it("no se borra", async () => {
    expect(await dbError(db.execute(sql`delete from booking_verifications`))).toMatch(/no admite DELETE/);
  });
});

describe("solo-inserción y enlaces", () => {
  it("el outbox, sus eventos y los consentimientos no admiten UPDATE ni DELETE", async () => {
    await db.execute(sql`
      insert into notifications (location_id, appointment_id, client_id, channel, template, recipient_hash, dedupe_key, params)
      values (${String(location)}::bigint, ${String(appointmentId)}::bigint, ${String(clientId)}::bigint, 'whatsapp', 'booking_confirmed', ${HEX("d")}, 'confirm:guards', '{}')`);
    await db.execute(sql`
      insert into notification_events (location_id, notification_id, kind)
      select location_id, id, 'attempt' from notifications where dedupe_key = 'confirm:guards'`);
    await db.execute(sql`
      insert into client_consents (location_id, client_id, purpose, granted, text_version, source)
      values (${String(location)}::bigint, ${String(clientId)}::bigint, 'reminders', true, '2026-11-01', 'online')`);

    expect(await dbError(db.execute(sql`update notifications set dedupe_key = 'otra' where dedupe_key = 'confirm:guards'`))).toMatch(/no admite UPDATE/);
    expect(await dbError(db.execute(sql`delete from notifications`))).toMatch(/no admite DELETE/);
    expect(await dbError(db.execute(sql`update notification_events set kind = 'sent'`))).toMatch(/no admite UPDATE/);
    expect(await dbError(db.execute(sql`delete from notification_events`))).toMatch(/no admite DELETE/);
    expect(await dbError(db.execute(sql`update client_consents set granted = false`))).toMatch(/no admite UPDATE/);
    expect(await dbError(db.execute(sql`truncate client_consents`))).toMatch(/no admite TRUNCATE/);
  });

  it("un enlace no cambia de token y revocarlo es definitivo", async () => {
    await db.execute(sql`
      insert into appointment_links (location_id, appointment_id, token_hash, expires_at)
      values (${String(location)}::bigint, ${String(appointmentId)}::bigint, ${HEX("e")}, now() + interval '7 days')`);
    expect(await dbError(db.execute(sql`update appointment_links set token_hash = ${HEX("f")}`))).toMatch(/no cambia de cita ni de token/);
    await db.execute(sql`update appointment_links set expires_at = now() + interval '9 days'`);
    await db.execute(sql`update appointment_links set revoked_at = now(), revoked_reason = 'cancelled'`);
    expect(await dbError(db.execute(sql`update appointment_links set revoked_at = null, revoked_reason = null`))).toMatch(/ya fue revocado/);
    expect(await dbError(db.execute(sql`delete from appointment_links`))).toMatch(/no admite DELETE/);
  });

  it("la retención de la sede queda entre 10 y 30 minutos", async () => {
    expect(await dbError(db.execute(sql`update locations set hold_min = 5 where id = ${String(location)}::bigint`))).toMatch(/locations_hold_min_check/);
  });
});
