import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINUTE_MS } from "@/domain/booking/clock";
import { findOrCreateClient } from "./clients";
import { createLocation } from "./ledger";
import { enqueueNotification } from "./notifications";
import { notificationEvents, notifications, workerHeartbeats } from "./schema";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";
import { deliveryStatus, HEARTBEAT_STALE_MS, recordHeartbeat, WORKER_NAME } from "./worker-heartbeat";
import { runHeartbeat } from "@/worker/jobs/heartbeat";

// Latido del worker (0030) y el aviso de envíos detenidos: worker sin latido reciente + avisos
// pendientes de la sede. La respuesta no lleva datos de clientes: solo booleanos.
// notifications es solo-inserción: created_at queda en now() del servidor, así que los casos usan
// la hora real y mueven send_after (la condición de "vencido para enviar").

let db: Db;
let client: PGlite;
let location: bigint;
let other: bigint;
const clientOf = new Map<bigint, bigint>();
let seq = 0;

/** Un recibo encolado (sale_receipt sin cita) que se puede enviar desde `sendAfter`. */
async function queuedReceipt(locationId: bigint, sendAfter: Date): Promise<bigint> {
  const key = `test:receipt:${++seq}`;
  await enqueueNotification(db, {
    locationId,
    appointmentId: null,
    clientId: clientOf.get(locationId)!,
    channel: "whatsapp",
    template: "sale_receipt",
    recipientHash: "ab".repeat(32),
    dedupeKey: key,
    sendAfter,
    params: { name: "Cliente" },
  });
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.locationId, locationId), eq(notifications.dedupeKey, key)));
  return row!.id;
}

async function addEvent(id: bigint, locationId: bigint, kind: "sent" | "suppressed" | "unknown" | "failed") {
  await db.insert(notificationEvents).values({ locationId, notificationId: id, kind });
}

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * MINUTE_MS);

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  location = await createLocation(db, { name: "Villa" });
  other = await createLocation(db, { name: "Otra sede" });
  clientOf.set(location, (await findOrCreateClient(db, { locationId: location, name: "Cliente", phone: "300 123 4567" })).id);
  clientOf.set(other, (await findOrCreateClient(db, { locationId: other, name: "Otro", phone: "301 555 1234" })).id);
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("latido del worker", () => {
  it("una fila por proceso: latir de nuevo solo mueve beat_at", async () => {
    const t0 = new Date("2026-11-06T15:00:00Z");
    await recordHeartbeat(db, t0);
    await recordHeartbeat(db, new Date(t0.getTime() + MINUTE_MS));
    expect(await db.select().from(workerHeartbeats)).toEqual([{ name: WORKER_NAME, beatAt: new Date(t0.getTime() + MINUTE_MS) }]);
  });

  it("el trabajo del worker solo late si puede entregar (sin configuración, el barrido está en pausa)", async () => {
    await db.delete(workerHeartbeats);
    const t = new Date("2026-11-06T15:30:00Z");
    expect(await runHeartbeat(db, t, { canDeliver: () => false })).toEqual({ beat: false });
    expect(await db.select().from(workerHeartbeats)).toEqual([]);
    expect(await runHeartbeat(db, t, { canDeliver: () => true })).toEqual({ beat: true });
    expect(await db.select().from(workerHeartbeats)).toEqual([{ name: WORKER_NAME, beatAt: t }]);
  });

  it("el nombre del proceso es corto y sin texto libre (CHECK)", async () => {
    expect(await dbError(recordHeartbeat(db, new Date(), "Worker con espacios"))).toMatch(/worker_heartbeats_name_check/);
  });

  it("propiedad: el worker está caído si y solo si el último latido tiene 5 minutos o más", async () => {
    const now = new Date("2026-11-06T16:00:00Z");
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 60 * MINUTE_MS }), async (ageMs) => {
        await recordHeartbeat(db, new Date(now.getTime() - ageMs));
        const { workerDown } = await deliveryStatus(db, location, now);
        expect(workerDown).toBe(ageMs >= HEARTBEAT_STALE_MS);
      }),
      { numRuns: 40 },
    );
  });
});

describe("envíos detenidos", () => {
  it("sin latido y con un recibo pendiente de la sede: detenidos; con latido reciente: no", async () => {
    const now = new Date();
    await db.delete(workerHeartbeats);
    // Worker caído pero nada en cola: no hay envíos detenidos.
    expect(await deliveryStatus(db, location, now)).toEqual({ workerDown: true, stalled: false });

    const id = await queuedReceipt(location, minutesAgo(now, 2));
    expect(await deliveryStatus(db, location, now)).toEqual({ workerDown: true, stalled: true });
    // La otra sede no tiene nada pendiente: no ve el aviso.
    expect(await deliveryStatus(db, other, now)).toEqual({ workerDown: true, stalled: false });

    // Latido de hace 6 minutos: sigue detenido. De hace 1 minuto: ya no.
    await recordHeartbeat(db, minutesAgo(now, 6));
    expect((await deliveryStatus(db, location, now)).stalled).toBe(true);
    await recordHeartbeat(db, minutesAgo(now, 1));
    expect(await deliveryStatus(db, location, now)).toEqual({ workerDown: false, stalled: false });

    // Con resultado definitivo deja de contar como pendiente.
    await db.delete(workerHeartbeats);
    await addEvent(id, location, "sent");
    expect((await deliveryStatus(db, location, now)).stalled).toBe(false);
  });

  it("no cuentan los que aún no vencen, los terminados (suppressed, unknown, 3 fallos) ni los de otra sede", async () => {
    const now = new Date();
    await db.delete(workerHeartbeats);
    expect((await deliveryStatus(db, location, now)).stalled).toBe(false);

    // Programado para dentro de una hora (como un recordatorio): no está atrasado.
    await queuedReceipt(location, new Date(now.getTime() + 60 * MINUTE_MS));
    expect((await deliveryStatus(db, location, now)).stalled).toBe(false);

    const suppressed = await queuedReceipt(location, minutesAgo(now, 1));
    await addEvent(suppressed, location, "suppressed");
    const unknown = await queuedReceipt(location, minutesAgo(now, 1));
    await addEvent(unknown, location, "unknown");
    const failed = await queuedReceipt(location, minutesAgo(now, 1));
    for (let i = 0; i < 3; i++) await addEvent(failed, location, "failed");
    expect((await deliveryStatus(db, location, now)).stalled).toBe(false);

    // Uno con un solo fallo se reintenta: sí cuenta.
    const retry = await queuedReceipt(location, minutesAgo(now, 1));
    await addEvent(retry, location, "failed");
    expect((await deliveryStatus(db, location, now)).stalled).toBe(true);
    await addEvent(retry, location, "sent");

    // De otra sede: no se ve aquí.
    await queuedReceipt(other, minutesAgo(now, 1));
    expect((await deliveryStatus(db, location, now)).stalled).toBe(false);
    expect((await deliveryStatus(db, other, now)).stalled).toBe(true);
  });

  it("una sede que no existe: caído y sin pendientes (nada que avisar)", async () => {
    await db.delete(workerHeartbeats);
    expect(await deliveryStatus(db, 999_999n, new Date())).toEqual({ workerDown: true, stalled: false });
  });
});

describe("permisos de villa_app sobre el latido", () => {
  let app: { db: Db; client: PGlite };
  beforeAll(async () => {
    app = await createTestDb({ role: "app" });
  }, 120_000);
  afterAll(async () => {
    await app?.client.close();
  });

  it("inserta y mueve beat_at, pero no renombra ni borra; y lee el estado de los envíos", async () => {
    await recordHeartbeat(app.db, new Date("2026-11-06T15:00:00Z"));
    await recordHeartbeat(app.db, new Date("2026-11-06T15:01:00Z"));
    expect(await dbError(app.client.query(`update worker_heartbeats set name = 'otro'`))).toMatch(/permission denied/);
    expect(await dbError(app.client.query(`delete from worker_heartbeats`))).toMatch(/permission denied/);
    expect(await app.db.select().from(workerHeartbeats)).toEqual([{ name: WORKER_NAME, beatAt: new Date("2026-11-06T15:01:00Z") }]);
    const loc = await createLocation(app.db, { name: "Villa" });
    expect(await deliveryStatus(app.db, loc, new Date("2026-11-06T15:02:00Z"))).toEqual({ workerDown: false, stalled: false });
  });
});
