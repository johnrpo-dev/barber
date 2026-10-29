import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINUTE_MS } from "@/domain/booking/clock";
import { deriveManageToken, manageLinkExpiry } from "@/domain/links/manage-token";
import { fromUnits } from "@/domain/money";
import { dedupeKey } from "@/domain/notifications/schedule";
import { MemoryNotifier } from "@/lib/notify/memory";
import { NotifyError } from "@/lib/notify/ports";
import { bucketHash } from "@/lib/public-readiness";
import { changeStatus, createAppointment, rescheduleAppointment } from "./appointments";
import { createService } from "./catalog";
import { findOrCreateClient } from "./clients";
import { recordConsents } from "./consents";
import { createLocation } from "./ledger";
import { findByManageToken, issueManageLink } from "./manage-links";
import {
  checkQuotaAlert,
  type DeliveryContext,
  deliverNotification,
  enqueueNotification,
  globalQuotaReached,
  messageParams,
  pendingNotificationIds,
  recordOtpAttempt,
  recordOtpOutcome,
  scanNotifications,
} from "./notifications";
import { appointmentLinks, clients, notificationEvents, notifications } from "./schema";
import { addStaffMember, setWeeklySchedule } from "./staff";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// Outbox: entrega a lo sumo una vez, cuotas, supresiones y recordatorios con consentimiento.

const PEPPER = "p".repeat(40);
const SECRET = "s".repeat(40);

let db: Db;
let client: PGlite;
let location: bigint;
let barber: bigint;
let service: bigint;
let seq = 0;

function ctxWith(over: Partial<DeliveryContext> = {}): DeliveryContext {
  return {
    hash: (v) => bucketHash(v, PEPPER),
    manageUrl: (publicId, generation) => `https://villa.test/cita/${deriveManageToken(SECRET, publicId, generation)}`,
    bookingUrl: "https://villa.test/reservar",
    caps: { perRecipientPerDay: 100, globalPerDay: 1000 },
    channels: ["whatsapp", "email"],
    ...over,
  };
}

/** Cliente nuevo con una cita confirmada que empieza en `hoursAhead` horas y su enlace. */
async function booked(hoursAhead: number, opts: { reminders?: boolean } = {}) {
  const k = ++seq;
  const phone = `300 ${String(1000000 + k).slice(-7, -4)} ${String(1000000 + k).slice(-4)}`;
  const c = await findOrCreateClient(db, { locationId: location, name: `Cliente ${k}`, phone });
  // Un barbero por cita: así nunca chocan los horarios entre casos.
  const staffId = await addStaffMember(db, { locationId: location, displayName: `Barbero ${k}`, role: "barber" });
  const start = new Date(Math.ceil((Date.now() + hoursAhead * 3_600_000) / (15 * MINUTE_MS)) * 15 * MINUTE_MS);
  const appt = await createAppointment(db, {
    locationId: location,
    serviceId: service,
    staffId,
    start,
    clientId: c.id,
    source: "staff",
    idempotencyKey: `notif-${k}`,
    createdBy: "seed",
    allowOutsideHours: true,
  });
  await issueManageLink(db, { locationId: location, appointmentId: appt.appointmentId, publicId: appt.publicId, appointmentEnd: new Date(appt.start.getTime() + 30 * MINUTE_MS), secret: SECRET });
  if (opts.reminders !== undefined) {
    await recordConsents(db, {
      locationId: location,
      clientId: c.id,
      appointmentId: appt.appointmentId,
      choices: { dataProcessing: true, reminders: opts.reminders, marketing: false },
      textVersion: "2026-11-01",
      ip: null,
      userAgent: null,
      source: "online",
    });
  }
  return { clientId: c.id, phone: c.phoneE164!, ...appt };
}

async function confirmation(b: Awaited<ReturnType<typeof booked>>, key = dedupeKey("confirm", b.publicId)) {
  await enqueueNotification(db, {
    locationId: location,
    appointmentId: b.appointmentId,
    clientId: b.clientId,
    channel: "whatsapp",
    template: "booking_confirmed",
    recipientHash: bucketHash(b.phone, PEPPER),
    dedupeKey: key,
    params: await messageParams(db, { locationId: location, appointmentId: b.appointmentId }),
  });
  const [row] = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.locationId, location), eq(notifications.dedupeKey, key)));
  return row!.id;
}

async function kinds(id: bigint): Promise<string[]> {
  const rows = await db.select({ kind: notificationEvents.kind }).from(notificationEvents).where(eq(notificationEvents.notificationId, id)).orderBy(notificationEvents.id);
  return rows.map((r) => r.kind);
}

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  location = await createLocation(db, { name: "Villa" });
  barber = await addStaffMember(db, { locationId: location, displayName: "Andrés", role: "barber" });
  await setWeeklySchedule(db, {
    locationId: location,
    staffId: barber,
    blocks: ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: 0, endMin: 1440 })),
  });
  service = (
    await createService(db, {
      locationId: location,
      draft: { name: "Corte", durationMin: 30, bufferMin: 0, price: fromUnits(30_000n), commissionBps: 4_000 },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("entrega", () => {
  it("encolar es idempotente por clave y la entrega recalcula el enlace (la base no guarda tokens)", async () => {
    const b = await booked(48);
    const id = await confirmation(b);
    await confirmation(b);
    expect(await db.$count(notifications, eq(notifications.dedupeKey, dedupeKey("confirm", b.publicId)))).toBe(1);
    const [stored] = await db.select({ params: notifications.params }).from(notifications).where(eq(notifications.id, id));
    expect(stored!.params.url).toBeUndefined();

    const n = new MemoryNotifier();
    expect(await deliverNotification(db, id, n, ctxWith())).toBe("sent");
    expect(await deliverNotification(db, id, n, ctxWith())).toBe("skipped");
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]!.to).toBe(b.phone);
    expect(n.sent[0]!.params.url).toBe(`https://villa.test/cita/${deriveManageToken(SECRET, b.publicId, 0)}`);
    expect(await kinds(id)).toEqual(["attempt", "sent"]);
  });

  it("propiedad: una clave nunca queda 'sent' dos veces aunque la entrega corra varias veces", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.boolean(), async (runs, parallel) => {
        const b = await booked(72);
        const id = await confirmation(b);
        const n = new MemoryNotifier();
        if (parallel) await Promise.all(Array.from({ length: runs }, () => deliverNotification(db, id, n, ctxWith())));
        else for (let i = 0; i < runs; i++) await deliverNotification(db, id, n, ctxWith());
        await confirmation(b); // volver a encolar tampoco duplica
        await deliverNotification(db, id, n, ctxWith());
        expect(n.sent).toHaveLength(1);
        expect((await kinds(id)).filter((k) => k === "sent")).toHaveLength(1);
      }),
      { numRuns: 8 },
    );
  });

  it("un error ambiguo queda 'unknown' y no se reintenta; un rechazo queda 'failed' y sí", async () => {
    const b1 = await booked(50);
    const id1 = await confirmation(b1);
    const n = new MemoryNotifier();
    n.failWith = new Error("timeout");
    expect(await deliverNotification(db, id1, n, ctxWith())).toBe("unknown");
    expect(await deliverNotification(db, id1, n, ctxWith())).toBe("skipped");
    expect(n.sent).toHaveLength(0);

    const b2 = await booked(51);
    const id2 = await confirmation(b2);
    n.failWith = new NotifyError("whatsapp_500");
    expect(await deliverNotification(db, id2, n, ctxWith())).toBe("failed");
    expect(await deliverNotification(db, id2, n, ctxWith())).toBe("sent");
  });

  it("un 'attempt' sin resultado después de 2 minutos pasa a 'unknown'", async () => {
    const b = await booked(52);
    const id = await confirmation(b);
    await db.insert(notificationEvents).values({ locationId: location, notificationId: id, kind: "attempt" });
    const n = new MemoryNotifier();
    expect(await deliverNotification(db, id, n, ctxWith())).toBe("skipped"); // todavía en vuelo
    expect(await deliverNotification(db, id, n, ctxWith(), new Date(Date.now() + 3 * MINUTE_MS))).toBe("unknown");
    expect(n.sent).toHaveLength(0);
  });

  it("plantilla sin aprobar: se suprime y se encola por correo si el cliente tiene", async () => {
    const b = await booked(53);
    await db.update(clients).set({ email: "ana@example.com" }).where(eq(clients.id, b.clientId));
    const id = await confirmation(b);
    const n = new MemoryNotifier();
    n.failWith = new NotifyError("whatsapp_400_132001", true);
    expect(await deliverNotification(db, id, n, ctxWith())).toBe("suppressed");
    const [twin] = await db.select({ id: notifications.id, channel: notifications.channel }).from(notifications).where(eq(notifications.dedupeKey, `${dedupeKey("confirm", b.publicId)}:email`));
    expect(twin!.channel).toBe("email");
    expect(await deliverNotification(db, twin!.id, n, ctxWith())).toBe("sent");
    expect(n.sent[0]!.to).toBe("ana@example.com");
  });

  it("la cuota por destinatario se respeta y un cliente anonimizado no recibe nada", async () => {
    const b = await booked(54);
    const n = new MemoryNotifier();
    const ctx = ctxWith({ caps: { perRecipientPerDay: 1, globalPerDay: 1000 } });
    expect(await deliverNotification(db, await confirmation(b, `q1:${b.publicId}`), n, ctx)).toBe("sent");
    const second = await confirmation(b, `q2:${b.publicId}`);
    expect(await deliverNotification(db, second, n, ctx)).toBe("suppressed");
    expect(await kinds(second)).toEqual(["suppressed"]);

    const anon = await booked(55);
    const id = await confirmation(anon);
    await db.update(clients).set({ anonymizedAt: new Date(), phoneE164: null }).where(eq(clients.id, anon.clientId));
    expect(await deliverNotification(db, id, n, ctxWith())).toBe("suppressed");
  });
});

describe("códigos de verificación en la cuota", () => {
  let otpSeq = 0;
  async function otpSent(b: Awaited<ReturnType<typeof booked>>, outcome: { providerMessageId: string } | { error: unknown } = { providerMessageId: "wamid.x" }) {
    const id = await recordOtpAttempt(db, {
      locationId: location,
      appointmentId: b.appointmentId,
      clientId: b.clientId,
      verificationId: BigInt(1_000_000 + ++otpSeq),
      recipientHash: bucketHash(b.phone, PEPPER),
    });
    await recordOtpOutcome(db, { locationId: location, id }, outcome);
    return id;
  }

  /** Enviados hoy en la sede, leído con globalQuotaReached (el tope más bajo que ya bloquea). */
  async function globalCount(loc: bigint, now: Date): Promise<number> {
    let lo = 0;
    let hi = 100_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await globalQuotaReached(db, { locationId: loc, timeZone: "America/Bogota", globalPerDay: mid + 1, now })) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  it("el worker nunca entrega un código; el código queda tachado y el resultado sigue la regla del outbox", async () => {
    const b = await booked(60);
    const sent = await otpSent(b);
    const failed = await otpSent(b, { error: new NotifyError("131026", false) });
    const unknown = await otpSent(b, { error: new Error("timeout") });
    expect(await kinds(sent)).toEqual(["attempt", "sent"]);
    expect(await kinds(failed)).toEqual(["attempt", "failed"]);
    expect(await kinds(unknown)).toEqual(["attempt", "unknown"]);
    const [row] = await db.select({ params: notifications.params, template: notifications.template }).from(notifications).where(eq(notifications.id, failed));
    expect(row).toEqual({ template: "otp", params: { code: "[redacted]" } });
    expect(await pendingNotificationIds(db, new Date(Date.now() + MINUTE_MS), 10_000)).not.toContain(failed);
    expect(await deliverNotification(db, failed, new MemoryNotifier(), ctxWith(), new Date(Date.now() + 5 * MINUTE_MS))).toBe("skipped");
    expect(await kinds(failed)).toEqual(["attempt", "failed"]);
  });

  it("los códigos cuentan en la cuota global (y el aviso del 80 %), no en la del destinatario", async () => {
    const b = await booked(61);
    const fresh = await createLocation(db, { name: "Sede de cuota" });
    const tz = "America/Bogota";
    const now = new Date();
    const base = await globalCount(location, now);
    // Tres códigos al mismo celular: la confirmación igual sale con tope de 1 por destinatario.
    for (let i = 0; i < 3; i++) await otpSent(b);
    expect(await globalCount(location, now)).toBe(base + 3);
    const n = new MemoryNotifier();
    const ctx = ctxWith({ caps: { perRecipientPerDay: 1, globalPerDay: 1000 } });
    expect(await deliverNotification(db, await confirmation(b, `otpq:${b.publicId}`), n, ctx)).toBe("sent");

    const total = base + 4;
    expect(await globalQuotaReached(db, { locationId: location, timeZone: tz, globalPerDay: total + 1, now })).toBe(false);
    expect(await globalQuotaReached(db, { locationId: location, timeZone: tz, globalPerDay: total, now })).toBe(true);
    expect(await globalQuotaReached(db, { locationId: fresh, timeZone: tz, globalPerDay: 1, now })).toBe(false);

    // Al 80 %: un aviso, una sola vez por sede y día, y solo para la sede pedida.
    const subjects: string[] = [];
    const alert = async (subject: string) => void subjects.push(subject);
    expect(await checkQuotaAlert(db, { caps: { globalPerDay: total }, alert }, now, fresh)).toBe(0);
    expect(await checkQuotaAlert(db, { caps: { globalPerDay: total }, alert }, now, location)).toBe(1);
    expect(await checkQuotaAlert(db, { caps: { globalPerDay: total }, alert }, now, location)).toBe(0);
    expect(subjects).toEqual([`Villa: van ${total} de ${total} mensajes hoy`]);
  });
});

describe("enlace de gestión y el panel", () => {
  const staff = () => ({ userId: "seed", role: "owner" as const, staffId: barber });
  const tokenOf = (b: { publicId: string }) => deriveManageToken(SECRET, b.publicId, 0);
  const revokedReason = async (appointmentId: bigint) =>
    (await db.select({ reason: appointmentLinks.revokedReason }).from(appointmentLinks).where(eq(appointmentLinks.appointmentId, appointmentId)))[0]!.reason;

  it("cancelar o marcar no-show desde el panel revoca el enlace con motivo 'staff'", async () => {
    const cancelled = await booked(70);
    await changeStatus(db, { locationId: location, appointmentId: cancelled.appointmentId, to: "cancelled", actor: staff(), cancelReason: "staff" });
    expect(await revokedReason(cancelled.appointmentId)).toBe("staff");
    expect(await findByManageToken(db, { locationId: location, token: tokenOf(cancelled), now: new Date(), allowRevoked: true })).toBeNull();

    const noShow = await booked(1);
    await changeStatus(db, { locationId: location, appointmentId: noShow.appointmentId, to: "no_show", actor: staff(), now: new Date(noShow.start.getTime() + 60 * MINUTE_MS) });
    expect(await revokedReason(noShow.appointmentId)).toBe("staff");

    // El cliente (desde su enlace) no pasa por aquí: cancelByClient revoca con motivo 'cancelled'.
    const byClient = await booked(71);
    await changeStatus(db, { locationId: location, appointmentId: byClient.appointmentId, to: "cancelled", actor: { kind: "client" }, cancelReason: "client" });
    expect(await revokedReason(byClient.appointmentId)).toBeNull();
  });

  it("reprogramar desde el panel alarga el enlace al nuevo fin", async () => {
    const moved = await booked(72);
    const newStart = new Date(moved.start.getTime() + 3 * 86_400_000);
    await rescheduleAppointment(db, { locationId: location, appointmentId: moved.appointmentId, start: newStart, staffId: moved.staffId, actor: staff(), allowOutsideHours: true });
    const [link] = await db
      .select({ expiresAt: appointmentLinks.expiresAt, revokedAt: appointmentLinks.revokedAt })
      .from(appointmentLinks)
      .where(eq(appointmentLinks.appointmentId, moved.appointmentId));
    expect(link!.revokedAt).toBeNull();
    expect(link!.expiresAt.getTime()).toBe(manageLinkExpiry(new Date(newStart.getTime() + 30 * MINUTE_MS)).getTime());
    expect(await findByManageToken(db, { locationId: location, token: tokenOf(moved), now: new Date(newStart.getTime() - MINUTE_MS) })).not.toBeNull();
  });
});

describe("barrido", () => {
  it("crea el recordatorio de 24 h solo con consentimiento y lo suprime si la cita se movió", async () => {
    const yes = await booked(20, { reminders: true });
    const no = await booked(20.5, { reminders: false });
    const none = await booked(21);
    const n = new MemoryNotifier();
    await scanNotifications(db, n, ctxWith());
    const rem = (b: { publicId: string; start: Date }) => dedupeKey("rem24", b.publicId, b.start);
    const keys = (await db.select({ key: notifications.dedupeKey }).from(notifications)).map((r) => r.key);
    expect(keys).toContain(rem(yes));
    expect(keys).not.toContain(rem(no));
    expect(keys).not.toContain(rem(none));
    expect(n.sent.filter((s) => s.template === "reminder_24h").map((s) => s.to)).toEqual([yes.phone]);

    // Otro cliente con consentimiento: se reprograma antes de entregar y el viejo queda suprimido.
    const moved = await booked(22, { reminders: true });
    const oldKey = rem(moved);
    const params = await messageParams(db, { locationId: location, appointmentId: moved.appointmentId });
    await enqueueNotification(db, {
      locationId: location,
      appointmentId: moved.appointmentId,
      clientId: moved.clientId,
      channel: "whatsapp",
      template: "reminder_24h",
      recipientHash: bucketHash(moved.phone, PEPPER),
      dedupeKey: oldKey,
      params,
    });
    await rescheduleAppointment(db, {
      locationId: location,
      appointmentId: moved.appointmentId,
      start: new Date(moved.start.getTime() + 60 * MINUTE_MS),
      staffId: moved.staffId,
      actor: { userId: "seed", role: "owner", staffId: moved.staffId },
      allowOutsideHours: true,
    });
    const before = n.sent.length;
    await scanNotifications(db, n, ctxWith());
    const [old] = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.dedupeKey, oldKey));
    expect(await kinds(old!.id)).toEqual(["suppressed"]);
    // El nuevo horario sí genera su recordatorio.
    expect(n.sent.slice(before).some((s) => s.template === "reminder_24h" && s.to === moved.phone)).toBe(true);
  });

  it("no manda dos veces aunque el barrido corra seguido", async () => {
    const b = await booked(23, { reminders: true });
    const n = new MemoryNotifier();
    await scanNotifications(db, n, ctxWith());
    await scanNotifications(db, n, ctxWith());
    expect(n.sent.filter((s) => s.to === b.phone)).toHaveLength(1);
  });
});
