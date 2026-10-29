import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { addDays, localMinuteToInstant, MINUTE_MS } from "@/domain/booking/clock";
import { instantLabels, ticketCode } from "@/domain/booking/public-labels";
import { businessDate } from "@/domain/ledger/business-date";
import { quotaState } from "@/domain/notifications/quota";
import { dedupeKey, dueReminders, REMINDER_DEDUPE } from "@/domain/notifications/schedule";
import { firstNameForMessage, type NotificationChannel, TEMPLATE_PARAMS } from "@/domain/notifications/templates";
import type { Notifier } from "@/lib/notify/ports";
import { NotifyError } from "@/lib/notify/ports";
import { describeError } from "@/lib/log";
import { hasLatestConsent } from "./consents";
import { activeLinkGeneration } from "./manage-links";
import { hit } from "./rate-limit";
import { appointments, clients, locations, notificationEvents, notifications, staffMembers } from "./schema";
import type { Db } from "./types";

// Outbox de mensajes al cliente (sprint-3-reserva-publica.md §5). La web escribe la intención
// dentro de la transacción del dominio; el worker la entrega A LO SUMO UNA VEZ:
//   1. pg_advisory_xact_lock por notificación   4. se inserta `attempt` y COMMIT
//   2. si ya hay `sent` (o terminó), nada        5. se llama al proveedor
//   3. cuota → si se pasó, `suppressed`          6. se inserta `sent` o `failed`
// Un `attempt` sin resultado después de 2 minutos pasa a `unknown` y no se reintenta: mejor
// perder un recordatorio que mandarlo dos veces. El destino se lee del cliente al entregar
// (un cliente anonimizado ya no recibe nada) y el enlace se recalcula: la base no guarda tokens.
//
// Los códigos de verificación ('otp') NO pasan por la cola: salen desde la web justo después
// del COMMIT. Igual quedan aquí (fila + attempt/sent/failed/unknown, con el código tachado)
// para que cuenten en la cuota global del día y disparen el aviso del 80 %.

export type OutboxTemplate = (typeof notifications.$inferInsert)["template"];
export type DeliveryOutcome = "sent" | "failed" | "unknown" | "suppressed" | "skipped";

const STALE_ATTEMPT_MS = 2 * MINUTE_MS;
const MAX_FAILED = 3;
/** Lo pendiente de hace más de esto ya no se manda (un recordatorio de anteayer no sirve). */
const MAX_AGE_MS = 2 * 24 * 60 * MINUTE_MS;
const NEEDS_LINK: readonly OutboxTemplate[] = ["booking_confirmed", "reminder_24h", "reminder_2h", "appointment_rescheduled"];
const REMINDERS: readonly OutboxTemplate[] = ["reminder_24h", "reminder_2h"];

export interface DeliveryContext {
  /** HMAC del destino (hashForBucket). */
  hash(value: string): string;
  /** Enlace completo de gestión para esa cita y generación. */
  manageUrl(publicId: string, generation: number): string;
  /** Enlace para volver a reservar (botón de la cancelación). */
  bookingUrl: string;
  caps: { perRecipientPerDay: number; globalPerDay: number };
  channels: readonly NotificationChannel[];
  /** Aviso al dueño cuando la cuota diaria llega al 80 %. */
  alert?: (subject: string, text: string, idempotencyKey: string) => Promise<void>;
}

// ─── Encolar ─────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  locationId: bigint;
  appointmentId: bigint | null;
  clientId: bigint;
  channel: NotificationChannel;
  template: OutboxTemplate;
  recipientHash: string;
  dedupeKey: string;
  sendAfter?: Date;
  /** Sin `url`: el enlace se calcula al entregar. */
  params: Record<string, string>;
}

/** Inserta la intención; si la clave ya existe no hace nada. Devuelve si la creó. */
export async function enqueueNotification(db: Db, input: EnqueueInput): Promise<boolean> {
  const { url: _url, ...params } = input.params;
  const rows = await db
    .insert(notifications)
    .values({
      locationId: input.locationId,
      appointmentId: input.appointmentId,
      clientId: input.clientId,
      channel: input.channel,
      template: input.template,
      recipientHash: input.recipientHash,
      dedupeKey: input.dedupeKey,
      sendAfter: input.sendAfter,
      params,
    })
    .onConflictDoNothing({ target: [notifications.locationId, notifications.dedupeKey] })
    .returning({ id: notifications.id });
  return rows.length > 0;
}

/** WhatsApp si hay celular y canal; si no, correo. null: no hay cómo avisarle. */
export function preferredChannel(
  client: { phoneE164: string | null; email: string | null },
  channels: readonly NotificationChannel[],
): { channel: NotificationChannel; to: string } | null {
  if (client.phoneE164 && channels.includes("whatsapp")) return { channel: "whatsapp", to: client.phoneE164 };
  if (client.email && channels.includes("email")) return { channel: "email", to: client.email };
  return null;
}

/** Parámetros de una cita para las plantillas (en la zona de la sede), sin el enlace. */
export async function messageParams(db: Db, input: { locationId: bigint; appointmentId: bigint }): Promise<Record<string, string>> {
  const [row] = await db
    .select({
      publicId: appointments.publicId,
      serviceName: appointments.serviceName,
      during: appointments.during,
      clientName: clients.name,
      staffName: staffMembers.displayName,
      timeZone: locations.timezone,
      address: locations.address,
      locationName: locations.name,
    })
    .from(appointments)
    .innerJoin(locations, eq(locations.id, appointments.locationId))
    .innerJoin(staffMembers, and(eq(staffMembers.locationId, appointments.locationId), eq(staffMembers.id, appointments.staffId)))
    .leftJoin(clients, and(eq(clients.locationId, appointments.locationId), eq(clients.id, appointments.clientId)))
    .where(and(eq(appointments.locationId, input.locationId), eq(appointments.id, input.appointmentId)));
  if (!row) throw new Error("La cita no existe");
  const { dateLabel, timeLabel } = instantLabels(row.during.start, row.timeZone);
  return {
    name: firstNameForMessage(row.clientName ?? "") || "cliente",
    service: row.serviceName,
    staff: row.staffName,
    date: dateLabel,
    time: timeLabel,
    ticket: ticketCode(row.publicId),
    address: row.address?.trim() || row.locationName,
  };
}

// ─── Entregar ────────────────────────────────────────────────────────────────

async function addEvent(
  db: Db,
  n: { locationId: bigint; id: bigint },
  kind: (typeof notificationEvents.$inferInsert)["kind"],
  extra: { providerMessageId?: string; errorCode?: string } = {},
): Promise<void> {
  await db.insert(notificationEvents).values({
    locationId: n.locationId,
    notificationId: n.id,
    kind,
    providerMessageId: extra.providerMessageId ?? null,
    errorCode: extra.errorCode?.slice(0, 60) ?? null,
  });
}

/**
 * Enviados hoy (día contable de la sede): al destinatario y en total en la sede. Los códigos
 * cuentan en el total pero no en el del destinatario (ese tope lo lleva otp_send por contacto).
 */
async function sentToday(db: Db, input: { locationId: bigint; recipientHash: string; timeZone: string; now: Date }) {
  const today = businessDate(input.now, input.timeZone);
  const from = localMinuteToInstant(today, 0, input.timeZone);
  const to = localMinuteToInstant(addDays(today, 1), 0, input.timeZone);
  const [row] = await db
    .select({
      recipient: sql<number>`count(*) filter (where ${notifications.recipientHash} = ${input.recipientHash} and ${notifications.template} <> 'otp')::int`,
      global: sql<number>`count(*)::int`,
    })
    .from(notificationEvents)
    .innerJoin(notifications, and(eq(notifications.locationId, notificationEvents.locationId), eq(notifications.id, notificationEvents.notificationId)))
    .where(
      and(
        eq(notificationEvents.locationId, input.locationId),
        eq(notificationEvents.kind, "sent"),
        sql`${notificationEvents.createdAt} >= ${from.toISOString()}::timestamptz`,
        sql`${notificationEvents.createdAt} < ${to.toISOString()}::timestamptz`,
      ),
    );
  return { recipient: Number(row?.recipient ?? 0), global: Number(row?.global ?? 0) };
}

type Prepared =
  | { kind: "done"; outcome: DeliveryOutcome }
  | {
      kind: "send";
      n: { id: bigint; locationId: bigint; clientId: bigint | null; appointmentId: bigint | null; dedupeKey: string; template: OutboxTemplate; channel: NotificationChannel; params: Record<string, string> };
      to: string;
      params: Record<string, string>;
      clientEmail: string | null;
    };

/**
 * Entrega una notificación a lo sumo una vez. Seguro de llamar varias veces y en paralelo
 * (el candado y el `attempt` ya confirmado lo impiden).
 */
export async function deliverNotification(db: Db, id: bigint, notifier: Notifier, ctx: DeliveryContext, now: Date = new Date()): Promise<DeliveryOutcome> {
  const prepared: Prepared = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`villa:notification:${id}`}, 0))`);

    const [n] = await tx
      .select({
        id: notifications.id,
        locationId: notifications.locationId,
        clientId: notifications.clientId,
        appointmentId: notifications.appointmentId,
        dedupeKey: notifications.dedupeKey,
        template: notifications.template,
        channel: notifications.channel,
        params: notifications.params,
        recipientHash: notifications.recipientHash,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.id, id));
    // Los códigos nunca los entrega el worker (ver arriba).
    if (!n || n.template === "otp") return { kind: "done", outcome: "skipped" };

    const events = await tx
      .select({ kind: notificationEvents.kind, createdAt: notificationEvents.createdAt })
      .from(notificationEvents)
      .where(and(eq(notificationEvents.locationId, n.locationId), eq(notificationEvents.notificationId, n.id)))
      .orderBy(asc(notificationEvents.id));
    if (events.some((e) => e.kind === "sent" || e.kind === "suppressed" || e.kind === "unknown")) return { kind: "done", outcome: "skipped" };
    const last = events.at(-1);
    if (last?.kind === "attempt") {
      if (now.getTime() - last.createdAt.getTime() < STALE_ATTEMPT_MS) return { kind: "done", outcome: "skipped" };
      await addEvent(tx, n, "unknown", { errorCode: "attempt_without_result" });
      return { kind: "done", outcome: "unknown" };
    }
    if (events.filter((e) => e.kind === "failed").length >= MAX_FAILED) return { kind: "done", outcome: "skipped" };

    const suppress = async (code: string): Promise<Prepared> => {
      await addEvent(tx, n, "suppressed", { errorCode: code });
      return { kind: "done", outcome: "suppressed" };
    };
    if (now.getTime() - n.createdAt.getTime() > MAX_AGE_MS) return suppress("too_old");

    const [ctxRow] = await tx
      .select({
        timeZone: locations.timezone,
        phoneE164: clients.phoneE164,
        email: clients.email,
        anonymizedAt: clients.anonymizedAt,
        clientId: clients.id,
        status: appointments.status,
        during: appointments.during,
        publicId: appointments.publicId,
        reminderConsent: n.clientId === null ? sql<boolean>`false` : sql<boolean>`${hasLatestConsent("reminders", n.locationId, n.clientId)}`,
      })
      .from(locations)
      .leftJoin(clients, and(eq(clients.locationId, locations.id), n.clientId === null ? sql`false` : eq(clients.id, n.clientId)))
      .leftJoin(appointments, and(eq(appointments.locationId, locations.id), n.appointmentId === null ? sql`false` : eq(appointments.id, n.appointmentId)))
      .where(eq(locations.id, n.locationId));
    if (!ctxRow || ctxRow.clientId === null || ctxRow.anonymizedAt) return suppress("no_client");
    if (!ctx.channels.includes(n.channel)) return suppress("channel_unavailable");
    const to = n.channel === "whatsapp" ? ctxRow.phoneE164 : ctxRow.email;
    if (!to) return suppress("no_destination");

    const startIso = ctxRow.during?.start.toISOString() ?? null;
    if (REMINDERS.includes(n.template)) {
      if (ctxRow.status !== "confirmed") return suppress("not_confirmed");
      if (!startIso || !n.dedupeKey.endsWith(`:${startIso}`)) return suppress("stale_start");
      if (!ctxRow.reminderConsent) return suppress("no_consent");
    }
    if (n.template === "appointment_rescheduled" && (!startIso || !n.dedupeKey.endsWith(`:${startIso}`))) return suppress("stale_start");
    if ((n.template === "booking_confirmed" || n.template === "appointment_rescheduled") && ctxRow.status === "cancelled") {
      return suppress("cancelled");
    }

    const params: Record<string, string> = { ...n.params };
    if (NEEDS_LINK.includes(n.template)) {
      if (!ctxRow.publicId || n.appointmentId === null) return suppress("no_link");
      const generation = await activeLinkGeneration(tx, { locationId: n.locationId, appointmentId: n.appointmentId });
      if (generation === null) return suppress("no_link");
      params.url = ctx.manageUrl(ctxRow.publicId, generation);
    } else if (TEMPLATE_PARAMS[n.template].includes("url")) {
      params.url = ctx.bookingUrl;
    }

    const sent = await sentToday(tx, { locationId: n.locationId, recipientHash: n.recipientHash, timeZone: ctxRow.timeZone, now });
    if (quotaState(sent.recipient, ctx.caps.perRecipientPerDay) === "blocked") return suppress("quota_recipient");
    if (quotaState(sent.global, ctx.caps.globalPerDay) === "blocked") return suppress("quota_global");

    await addEvent(tx, n, "attempt");
    return { kind: "send", n, to, params, clientEmail: ctxRow.email };
  });

  if (prepared.kind === "done") return prepared.outcome;
  const { n, to, params } = prepared;

  try {
    const { providerMessageId } = await notifier.send({ channel: n.channel, template: n.template, to, params, idempotencyKey: `${n.locationId}:${n.dedupeKey}` });
    await addEvent(db, n, "sent", { providerMessageId });
    return "sent";
  } catch (err) {
    if (err instanceof NotifyError) {
      if (err.templateUnavailable) {
        // Plantilla sin aprobar: esta queda suprimida y, si hay correo, se intenta por ahí.
        await addEvent(db, n, "suppressed", { errorCode: err.code });
        if (n.channel === "whatsapp" && prepared.clientEmail && ctx.channels.includes("email") && n.clientId !== null) {
          await enqueueNotification(db, {
            locationId: n.locationId,
            appointmentId: n.appointmentId,
            clientId: n.clientId,
            channel: "email",
            template: n.template,
            recipientHash: ctx.hash(prepared.clientEmail),
            dedupeKey: `${n.dedupeKey}:email`,
            params: n.params,
          });
        }
        return "suppressed";
      }
      await addEvent(db, n, "failed", { errorCode: err.code });
      return "failed";
    }
    // Error de red, timeout o respuesta ambigua: pudo salir. No se reintenta.
    console.error("[notify] envío con resultado desconocido", { notificationId: String(n.id), template: n.template, ...describeError(err) });
    await addEvent(db, n, "unknown", { errorCode: "ambiguous" });
    return "unknown";
  }
}

// ─── Barrido del worker ──────────────────────────────────────────────────────

/** Crea los recordatorios que tocan (solo citas confirmadas con consentimiento vigente). */
export async function createDueReminders(db: Db, ctx: DeliveryContext, now: Date): Promise<number> {
  const rows = await db
    .select({
      locationId: appointments.locationId,
      appointmentId: appointments.id,
      publicId: appointments.publicId,
      during: appointments.during,
      clientId: clients.id,
      phoneE164: clients.phoneE164,
      email: clients.email,
    })
    .from(appointments)
    .innerJoin(clients, and(eq(clients.locationId, appointments.locationId), eq(clients.id, appointments.clientId)))
    .where(
      and(
        eq(appointments.status, "confirmed"),
        sql`lower(${appointments.during}) > ${new Date(now.getTime() + 30 * MINUTE_MS).toISOString()}::timestamptz`,
        sql`lower(${appointments.during}) <= ${new Date(now.getTime() + 24 * 60 * MINUTE_MS).toISOString()}::timestamptz`,
        sql`${clients.anonymizedAt} is null`,
        sql`${hasLatestConsent("reminders", appointments.locationId, appointments.clientId)}`,
      ),
    );

  const wanted = rows.flatMap((r) =>
    dueReminders(now, r.during.start).map((kind) => ({ ...r, kind, key: dedupeKey(REMINDER_DEDUPE[kind], r.publicId, r.during.start) })),
  );
  if (wanted.length === 0) return 0;
  const existing = new Set(
    (
      await db
        .select({ locationId: notifications.locationId, key: notifications.dedupeKey })
        .from(notifications)
        .where(inArray(notifications.dedupeKey, wanted.map((w) => w.key)))
    ).map((e) => `${e.locationId}|${e.key}`),
  );

  let created = 0;
  for (const w of wanted) {
    if (existing.has(`${w.locationId}|${w.key}`)) continue;
    const target = preferredChannel(w, ctx.channels);
    if (!target) continue;
    const params = await messageParams(db, { locationId: w.locationId, appointmentId: w.appointmentId });
    if (
      await enqueueNotification(db, {
        locationId: w.locationId,
        appointmentId: w.appointmentId,
        clientId: w.clientId,
        channel: target.channel,
        template: w.kind,
        recipientHash: ctx.hash(target.to),
        dedupeKey: w.key,
        // El mismo reloj del barrido: si no, el reloj de la base lo dejaría para el siguiente.
        sendAfter: now,
        params,
      })
    ) {
      created++;
    }
  }
  return created;
}

/** IDs pendientes de entregar: sin resultado definitivo, vencidos para enviar y no tan viejos. */
export async function pendingNotificationIds(db: Db, now: Date, limit = 100): Promise<bigint[]> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        ne(notifications.template, "otp"),
        sql`${notifications.sendAfter} <= ${now.toISOString()}::timestamptz`,
        sql`${notifications.createdAt} > ${new Date(now.getTime() - MAX_AGE_MS - 60 * MINUTE_MS).toISOString()}::timestamptz`,
        sql`not exists (
          select 1 from notification_events e
          where e.location_id = ${notifications.locationId} and e.notification_id = ${notifications.id}
            and e.kind in ('sent', 'suppressed', 'unknown')
        )`,
        sql`(select count(*) from notification_events e
             where e.location_id = ${notifications.locationId} and e.notification_id = ${notifications.id} and e.kind = 'failed') < ${MAX_FAILED}`,
      ),
    )
    .orderBy(asc(notifications.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

type QuotaAlert = { caps: { globalPerDay: number }; alert?: DeliveryContext["alert"] };

/** El aviso del 80 % para una sede: true si lo mandó (una vez por sede y día). */
async function alertSedeNearQuota(db: Db, loc: { id: bigint; timeZone: string; name: string }, ctx: QuotaAlert, now: Date): Promise<boolean> {
  if (!ctx.alert) return false;
  const { global } = await sentToday(db, { locationId: loc.id, recipientHash: "", timeZone: loc.timeZone, now });
  if (quotaState(global, ctx.caps.globalPerDay) === "ok") return false;
  const today = businessDate(now, loc.timeZone);
  // El contador de límites sirve de bandera "ya avisé hoy": solo el primer golpe envía.
  if ((await hit(db, `alert:quota:${loc.id}`, localMinuteToInstant(today, 0, loc.timeZone))) !== 1) return false;
  await ctx.alert(
    `Villa: van ${global} de ${ctx.caps.globalPerDay} mensajes hoy`,
    `La sede ${loc.name} ya envió ${global} mensajes hoy (${today}). Al llegar a ${ctx.caps.globalPerDay}, los demás quedan suprimidos hasta mañana.`,
    `alert:quota:${loc.id}:${today}`,
  );
  return true;
}

/** Al 80 % de la cuota global del día, un correo al dueño (una vez por sede y día). */
export async function checkQuotaAlert(db: Db, ctx: QuotaAlert, now: Date, onlyLocationId?: bigint): Promise<number> {
  if (!ctx.alert) return 0;
  const locs = await db
    .select({ id: locations.id, timeZone: locations.timezone, name: locations.name })
    .from(locations)
    .where(onlyLocationId === undefined ? undefined : eq(locations.id, onlyLocationId));
  let alerts = 0;
  for (const loc of locs) if (await alertSedeNearQuota(db, loc, ctx, now)) alerts++;
  return alerts;
}

// ─── Códigos de verificación en la cuota ─────────────────────────────────────

/** ¿Ya se llegó a la cuota global del día en la sede? (códigos incluidos). */
export async function globalQuotaReached(db: Db, input: { locationId: bigint; timeZone: string; globalPerDay: number; now: Date }): Promise<boolean> {
  const { global } = await sentToday(db, { locationId: input.locationId, recipientHash: "", timeZone: input.timeZone, now: input.now });
  return quotaState(global, input.globalPerDay) === "blocked";
}

/**
 * Registra el envío de un código (fila 'otp' con el código tachado + `attempt`) dentro de la
 * transacción que crea la verificación: el `attempt` queda confirmado antes de llamar al proveedor.
 */
export async function recordOtpAttempt(
  db: Db,
  input: { locationId: bigint; appointmentId: bigint; clientId: bigint; verificationId: bigint; recipientHash: string },
): Promise<bigint> {
  const [row] = await db
    .insert(notifications)
    .values({
      locationId: input.locationId,
      appointmentId: input.appointmentId,
      clientId: input.clientId,
      channel: "whatsapp",
      template: "otp",
      recipientHash: input.recipientHash,
      dedupeKey: `otp:${input.verificationId}`,
      params: { code: "[redacted]" },
    })
    .returning({ id: notifications.id });
  await addEvent(db, { locationId: input.locationId, id: row!.id }, "attempt");
  return row!.id;
}

/** El resultado del envío de un código, con la misma regla del outbox (NotifyError → failed; lo demás → unknown). */
export async function recordOtpOutcome(
  db: Db,
  n: { locationId: bigint; id: bigint },
  outcome: { providerMessageId: string } | { error: unknown },
): Promise<void> {
  if ("providerMessageId" in outcome) return addEvent(db, n, "sent", { providerMessageId: outcome.providerMessageId });
  if (outcome.error instanceof NotifyError) return addEvent(db, n, "failed", { errorCode: outcome.error.code });
  return addEvent(db, n, "unknown", { errorCode: "ambiguous" });
}

/** El job de cada minuto: recordatorios nuevos y entrega de lo pendiente. */
export async function scanNotifications(
  db: Db,
  notifier: Notifier,
  ctx: DeliveryContext,
  now: Date = new Date(),
): Promise<{ created: number; outcomes: Record<DeliveryOutcome, number> }> {
  const created = await createDueReminders(db, ctx, now);
  const outcomes: Record<DeliveryOutcome, number> = { sent: 0, failed: 0, unknown: 0, suppressed: 0, skipped: 0 };
  for (const id of await pendingNotificationIds(db, now)) {
    outcomes[await deliverNotification(db, id, notifier, ctx, now)]++;
  }
  await checkQuotaAlert(db, ctx, now);
  return { created, outcomes };
}
