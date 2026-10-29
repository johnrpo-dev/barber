import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { BookingError } from "@/domain/booking/appointment";
import { activeLimitReached, clientCanCancel, clientCanReschedule, type ClientDecision } from "@/domain/booking/client-policy";
import { addDays, datesBetween, localMinuteToInstant, MINUTE_MS } from "@/domain/booking/clock";
import { merge } from "@/domain/booking/interval";
import {
  dayPeriod,
  formatClock,
  initials,
  instantLabels,
  localParts,
  PUBLIC_STATUS_LABELS,
  ticketCode,
} from "@/domain/booking/public-labels";
import type { AppointmentStatus } from "@/domain/booking/status";
import { assertValidClientName, InvalidClientError, maskPhone, normalizePhone } from "@/domain/clients/client";
import { assertBookingConsent, type ConsentChoices } from "@/domain/clients/consent";
import { businessDate } from "@/domain/ledger/business-date";
import { format, money } from "@/domain/money";
import { dedupeKey } from "@/domain/notifications/schedule";
import { firstNameForMessage, type NotificationChannel } from "@/domain/notifications/templates";
import { WEEKDAY_LABELS, type Weekday } from "@/domain/staff/schedule";
import { canResendOtp, generateOtp, hashOtp, normalizeOtpInput, OTP_MAX_SENDS, OTP_RESEND_COOLDOWN_SEC, otpExpiry, otpMatches } from "@/domain/verification/otp";
import { CURRENT_PRIVACY_VERSION } from "@/content/privacy/versions";
import { describeError } from "@/lib/log";
import type { Notifier } from "@/lib/notify/ports";
import { availability, changeStatus, createAppointment, locationRules, rescheduleAppointment, SlotTakenError } from "./appointments";
import { findOrCreateClient } from "./clients";
import { recordConsents } from "./consents";
import { findByManageToken, issueManageLink, revokeManageLinks } from "./manage-links";
import { checkQuotaAlert, enqueueNotification, globalQuotaReached, messageParams, preferredChannel, recordOtpAttempt, recordOtpOutcome } from "./notifications";
import { enforce } from "./rate-limit";
import { appointmentEvents, appointments, bookingVerifications, clients, locations, services, staffMembers, staffSchedules } from "./schema";
import type { Db } from "./types";

// Reserva pública (sprint-3-reserva-publica.md §1–§4). Las acciones de src/app/(publico) son
// delgadas: validan la forma, comprueban Turnstile y la IP, y llaman aquí.
//   startOnlineBooking → retención pending + código (el código sale DESPUÉS del COMMIT, nunca
//                        por la cola, y en la base solo queda su HMAC). El código va SOLO por
//                        WhatsApp a un celular colombiano; el nombre y el correo escritos se
//                        guardan con la verificación y pasan al cliente solo al verificar.
//   verifyBooking      → intento contado ANTES de comparar; si coincide, una transacción:
//                        consume, confirma, tope de activas, consentimientos, enlace y outbox.
//   cancelByClient / rescheduleByClient → desde el enlace de gestión.

/** Textos que la interfaz muestra tal cual (sprint-3-diseno-portal.md §5 y el contrato §10). */
export const PUBLIC_MESSAGES = {
  slotTaken: "Uy, alguien tomó ese horario justo antes que tú. Elige otro; tus datos siguen aquí.",
  tooSoon: "Ese horario ya no se puede reservar en línea. Elige uno más adelante.",
  holdExpired: "Se acabó el tiempo y liberamos el horario. Elige otro; tus datos siguen aquí.",
  codeShape: "Ese código no coincide. Escribe los 6 dígitos que te enviamos.",
  codeExpired: "El código venció (dura 5 minutos).",
  tooManyAttempts: "Demasiados intentos. Por seguridad, espera 15 minutos o escríbenos por WhatsApp.",
  codeUsed: "Ese código ya se usó. Si tu cita no quedó confirmada, reserva de nuevo.",
  linkInvalid: "Este enlace ya no funciona.",
  sameTime: "Esa ya es la hora de tu cita.",
  phone: "El celular no es válido: escribe un celular colombiano (ej. 300 123 4567).",
  dateOutOfRange: "Esa fecha no está disponible para reservar. Elige otra.",
  sendingPaused: "Hoy no podemos enviar más códigos. Para reservar, llámanos o escríbenos por WhatsApp.",
  generic: "No se pudo completar. Intenta de nuevo.",
} as const;

/** Retenciones en línea vivas a la vez por sede: más que esto es alguien acaparando la agenda. */
export const MAX_PENDING_HOLDS = 20;

const COLOMBIAN_MOBILE = /^\+573\d{9}$/;

/** El celular para la reserva pública: solo móviles colombianos (+57 3xx, 10 dígitos). El panel usa normalizePhone. */
export function publicMobile(raw: string): string | null {
  const phone = normalizePhone(raw);
  return phone && COLOMBIAN_MOBILE.test(phone) ? phone : null;
}

/** Rechaza, antes de consultar nada, fechas fuera de [hoy, hoy + maxAdvanceDays] en la sede. */
export function assertBookableDate(location: { timeZone: string; maxAdvanceDays: number }, date: string, now: Date): void {
  const today = businessDate(now, location.timeZone);
  if (date < today || date > addDays(today, location.maxAdvanceDays)) throw new BookingError(PUBLIC_MESSAGES.dateOutOfRange);
}

export function wrongCodeMessage(left: number): string {
  if (left <= 0) return "Ese código no coincide. Ya no te quedan intentos: pide un código nuevo.";
  return left === 1 ? "Ese código no coincide. Te queda 1 intento." : `Ese código no coincide. Te quedan ${left} intentos.`;
}

export function activeLimitMessage(max: number): string {
  return `Ya tienes ${max} citas activas con este número. Revísalas desde el enlace que te enviamos por WhatsApp.`;
}

const CANCEL_REASON_TEXT: Record<Exclude<ClientDecision, { ok: true }>["reason"], string> = {
  started: "Tu cita ya empezó; ya no se puede cambiar desde aquí. Escríbenos por WhatsApp.",
  not_active: "Esta cita ya no se puede cambiar desde aquí.",
  late_window: "", // se arma con las horas de la sede
  too_many: "Ya reprogramaste esta cita 2 veces. Para otro cambio, escríbenos por WhatsApp.",
  not_confirmed: "Tu cita todavía no está confirmada.",
};

function decisionMessage(d: Exclude<ClientDecision, { ok: true }>, freeCancelHours: number): string {
  if (d.reason === "late_window") return `Faltan menos de ${freeCancelHours} horas para tu cita. Para cambiarla, llama a la barbería.`;
  return CANCEL_REASON_TEXT[d.reason];
}

export interface PublicBookingContext {
  locationId: bigint;
  now: Date;
  otpPepper: string;
  manageLinkSecret: string;
  channels: readonly NotificationChannel[];
  /** HMAC para cubetas de límites y hashes de destinatarios (hashForBucket). */
  hash(value: string): string;
  /** Cuota global diaria de mensajes de la sede: los códigos cuentan. */
  caps: { globalPerDay: number };
  /** Aviso al dueño al 80 % de la cuota (ALERT_EMAIL). */
  alert?: (subject: string, text: string, idempotencyKey: string) => Promise<void>;
}

/** Filas de db.execute sin importar el driver (postgres.js devuelve un arreglo; PGlite, { rows }). */
function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

export function hashBrowserCookie(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const iso = (d: Date) => d.toISOString();

// ─── Sede, catálogo y horarios ───────────────────────────────────────────────

export interface PublicLocation {
  id: bigint;
  name: string;
  timeZone: string;
  publicBookingEnabled: boolean;
  publicPhone: string | null;
  address: string | null;
  mapsUrl: string | null;
  maxAdvanceDays: number;
  holdMin: number;
  minAdvanceMin: number;
  freeCancelHours: number;
  maxActivePerClient: number;
}

/**
 * La sede pública: la primera con la reserva activa. Con `fallbackToFirst`, si ninguna la tiene
 * activa se usa la primera sede (los enlaces de citas ya hechas siguen sirviendo).
 */
export async function publicLocation(db: Db, opts: { fallbackToFirst?: boolean } = {}): Promise<PublicLocation | null> {
  const [row] = await db
    .select({
      id: locations.id,
      name: locations.name,
      timeZone: locations.timezone,
      publicBookingEnabled: locations.publicBookingEnabled,
      publicPhone: locations.publicPhone,
      address: locations.address,
      mapsUrl: locations.mapsUrl,
      maxAdvanceDays: locations.maxAdvanceDays,
      holdMin: locations.holdMin,
      minAdvanceMin: locations.minAdvanceMin,
      freeCancelHours: locations.freeCancelHours,
      maxActivePerClient: locations.maxActivePerClient,
    })
    .from(locations)
    .where(opts.fallbackToFirst ? undefined : eq(locations.publicBookingEnabled, true))
    .orderBy(desc(locations.publicBookingEnabled), asc(locations.id))
    .limit(1);
  return row ?? null;
}

/** uuid público del servicio → id interno (activo y de esta sede). */
export async function resolveServiceId(db: Db, locationId: bigint, publicId: string): Promise<bigint> {
  const [row] = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.locationId, locationId), eq(services.publicId, publicId), eq(services.active, true)));
  if (!row) throw new BookingError("Ese servicio ya no está disponible. Elige otro.");
  return row.id;
}

/** uuid público del barbero → id interno (activo, de esta sede y que atiende en línea). */
export async function resolveStaffId(db: Db, locationId: bigint, publicId: string): Promise<bigint> {
  const [row] = await db
    .select({ id: staffMembers.id })
    .from(staffMembers)
    .where(
      and(
        eq(staffMembers.locationId, locationId),
        eq(staffMembers.publicId, publicId),
        eq(staffMembers.active, true),
        eq(staffMembers.bookableOnline, true),
      ),
    );
  if (!row) throw new BookingError("Ese barbero no está disponible en línea. Elige otro.");
  return row.id;
}

export interface SlotView {
  minute: number;
  label: string;
  period: "morning" | "afternoon" | "evening";
}

/** Horarios libres de un día, como los ve el cliente. */
export async function publicSlots(
  db: Db,
  input: { location: PublicLocation; serviceId: bigint; staffId: bigint | "any"; date: string; now: Date; excludeAppointmentId?: bigint },
): Promise<SlotView[]> {
  assertBookableDate(input.location, input.date, input.now);
  const slots = await availability(db, {
    locationId: input.location.id,
    serviceId: input.serviceId,
    fromDate: input.date,
    toDate: input.date,
    staffId: input.staffId === "any" ? undefined : input.staffId,
    now: input.now,
    internal: false,
    excludeAppointmentId: input.excludeAppointmentId,
  });
  return slots
    .map((s) => localParts(s.start, input.location.timeZone))
    .filter((p) => p.date === input.date)
    .map(({ minute }) => ({ minute, label: formatClock(minute), period: dayPeriod(minute) }));
}

/** Conteo de horarios por día, desde hoy y por maxAdvanceDays días (una sola consulta). */
export async function publicDaySummary(
  db: Db,
  input: { location: PublicLocation; serviceId: bigint; staffId: bigint | "any"; now: Date; excludeAppointmentId?: bigint },
): Promise<{ date: string; count: number; closed: boolean }[]> {
  const today = businessDate(input.now, input.location.timeZone);
  const last = addDays(today, Math.max(1, input.location.maxAdvanceDays) - 1);
  const query = {
    locationId: input.location.id,
    serviceId: input.serviceId,
    fromDate: today,
    toDate: last,
    staffId: input.staffId === "any" ? undefined : input.staffId,
    now: input.now,
    internal: false,
    excludeAppointmentId: input.excludeAppointmentId,
  };
  const perDay = (slots: { start: Date }[]) => {
    const counts = new Map<string, number>();
    for (const s of slots) {
      const d = businessDate(s.start, input.location.timeZone);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return counts;
  };
  const free = perDay(await availability(db, query));
  // Sin citas de por medio, ¿habría horarios? Si no, el día está cerrado (sin turno, festivo,
  // ausencia o ya pasó la hora); si sí, está lleno.
  const open = perDay(await availability(db, { ...query, ignoreAppointments: true }));
  return datesBetween(today, last).map((date) => ({ date, count: free.get(date) ?? 0, closed: (open.get(date) ?? 0) === 0 }));
}

/** Comprueba que ese inicio se ofrece en línea (anticipación, horizonte, barberos en línea). */
async function assertSlotOffered(
  db: Db,
  input: { location: PublicLocation; serviceId: bigint; staffId: bigint | "any"; start: Date; now: Date; excludeAppointmentId?: bigint },
): Promise<void> {
  const { date } = localParts(input.start, input.location.timeZone);
  const slots = await availability(db, {
    locationId: input.location.id,
    serviceId: input.serviceId,
    fromDate: date,
    toDate: date,
    staffId: input.staffId === "any" ? undefined : input.staffId,
    now: input.now,
    internal: false,
    excludeAppointmentId: input.excludeAppointmentId,
  });
  if (slots.some((s) => s.start.getTime() === input.start.getTime())) return;
  if (input.start.getTime() < input.now.getTime() + input.location.minAdvanceMin * MINUTE_MS) throw new BookingError(PUBLIC_MESSAGES.tooSoon);
  throw new SlotTakenError(PUBLIC_MESSAGES.slotTaken);
}

// ─── Retener y enviar el código ──────────────────────────────────────────────

export interface StartBookingInput {
  serviceId: bigint;
  staffId: bigint | "any";
  start: Date;
  name: string;
  phone: string;
  email?: string | null;
  consents: ConsentChoices;
  formId: string;
  browserHash: string;
  /** IP completa: evidencia del consentimiento. */
  ip: string | null;
  /** Sujeto del límite por IP (HMAC de la cubeta, IPv6 por /64). */
  ipSubject: string;
  userAgent: string | null;
}

export interface StartBookingResult {
  channel: NotificationChannel;
  maskedDestination: string;
  holdExpiresAt: Date;
  resendAvailableAt: Date;
}

async function insertVerification(
  tx: Db,
  input: {
    locationId: bigint;
    appointmentId: bigint;
    clientId: bigint;
    channel: NotificationChannel;
    browserHash: string;
    expiresAt: Date;
    consentChoices: ConsentChoices;
    consentTextVersion: string;
    consentIp: string | null;
    consentUserAgent: string | null;
    /** Lo que escribió quien reserva; pasa al cliente solo al verificar. */
    contactName: string | null;
    contactEmail: string | null;
    pepper: string;
  },
): Promise<{ id: bigint; code: string }> {
  // El hash va ligado al id de la verificación y code_hash no se puede editar (trigger): se pide
  // el id antes de insertar.
  const [seq] = rowsOf<{ id: string }>(
    await tx.execute(sql`select nextval(pg_get_serial_sequence('booking_verifications', 'id'))::text as id`),
  );
  const id = BigInt(seq!.id);
  const code = generateOtp();
  const codeHash = hashOtp(input.pepper, id, code).toString("hex");
  await tx.execute(sql`
    insert into booking_verifications
      (id, location_id, appointment_id, client_id, channel, code_hash, browser_hash, expires_at,
       consent_choices, consent_text_version, consent_ip, consent_user_agent, contact_name, contact_email)
    overriding system value values
      (${String(id)}::bigint, ${String(input.locationId)}::bigint, ${String(input.appointmentId)}::bigint,
       ${String(input.clientId)}::bigint, ${input.channel}, ${codeHash}, ${input.browserHash},
       ${iso(input.expiresAt)}::timestamptz, ${JSON.stringify(input.consentChoices)}::jsonb, ${input.consentTextVersion},
       ${input.consentIp?.slice(0, 45) ?? null}, ${input.consentUserAgent?.slice(0, 300) ?? null},
       ${input.contactName}, ${input.contactEmail})`);
  return { id, code };
}

/**
 * Los límites de envío de código (IP, celular y la sede entera) y la cuota global del día.
 * Va dentro de la transacción, justo antes de crear la verificación: solo cuenta lo que de
 * verdad llega a enviarse (si algo falla antes, el golpe se deshace con el ROLLBACK).
 */
async function assertCanSendCode(tx: Db, ctx: PublicBookingContext, input: { timeZone: string; ipSubject: string; phone: string }): Promise<void> {
  if (await globalQuotaReached(tx, { locationId: ctx.locationId, timeZone: input.timeZone, globalPerDay: ctx.caps.globalPerDay, now: ctx.now })) {
    throw new BookingError(PUBLIC_MESSAGES.sendingPaused);
  }
  await enforce(tx, "otp_send", { ip: input.ipSubject, contact: ctx.hash(input.phone), location: `location:${ctx.locationId}` }, ctx.now);
}

/** Envía el código por WhatsApp (después del COMMIT), anota el resultado y revisa el aviso del 80 %. */
async function sendCode(
  db: Db,
  ctx: PublicBookingContext,
  notifier: Notifier,
  input: { to: string; code: string; verificationId: bigint; notificationId: bigint },
): Promise<void> {
  const n = { locationId: ctx.locationId, id: input.notificationId };
  let outcome: { providerMessageId: string } | { error: unknown };
  try {
    outcome = await notifier.send({ channel: "whatsapp", template: "otp", to: input.to, params: { code: input.code }, idempotencyKey: `otp:${input.verificationId}` });
  } catch (err) {
    // Sin el destino ni el código. Quien reserva puede pedir otro código en 60 s.
    console.error("[reserva] no se pudo enviar el código", { verificationId: String(input.verificationId), ...describeError(err) });
    outcome = { error: err };
  }
  try {
    await recordOtpOutcome(db, n, outcome);
    if (ctx.alert) await checkQuotaAlert(db, { caps: ctx.caps, alert: ctx.alert }, ctx.now, ctx.locationId);
  } catch (err) {
    console.error("[reserva] no se pudo anotar el envío del código", { verificationId: String(input.verificationId), ...describeError(err) });
  }
}

/**
 * Retiene el horario y envía el código. Responde igual para un celular nuevo o uno que ya
 * existe (sin enumeración): el código se envía en ambos casos. Al cliente que ya existe no se le
 * toca nada aquí: el nombre y el correo escritos esperan en la verificación (verifyBooking).
 */
export async function startOnlineBooking(
  db: Db,
  ctx: PublicBookingContext,
  location: PublicLocation,
  input: StartBookingInput,
  notifier: Notifier,
): Promise<StartBookingResult> {
  const now = ctx.now;
  assertBookingConsent(input.consents);
  const name = assertValidClientName(input.name);
  const phone = publicMobile(input.phone);
  if (!phone) throw new InvalidClientError(PUBLIC_MESSAGES.phone);
  const email = input.email?.trim().toLowerCase() || null;
  if (email && (email.length > 254 || !email.includes("@"))) throw new InvalidClientError("El correo no es válido");
  // El código sale solo por WhatsApp: el correo no prueba que el celular sea de quien reserva.
  if (!ctx.channels.includes("whatsapp")) throw new BookingError(PUBLIC_MESSAGES.generic);
  assertBookableDate(location, localParts(input.start, location.timeZone).date, now);

  await enforce(db, "booking_start", { contact: ctx.hash(phone) }, now);
  await assertSlotOffered(db, { location, serviceId: input.serviceId, staffId: input.staffId, start: input.start, now });

  const result = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Tope de retenciones vivas por sede, con candado para que el conteo y la nueva no se crucen.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`villa:holds:${location.id}`}, 0))`);
    const client = await findOrCreateClient(tx, { locationId: location.id, name, phone });
    const [holds] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(appointments)
      .where(
        and(
          eq(appointments.locationId, location.id),
          eq(appointments.status, "pending"),
          eq(appointments.source, "online"),
          sql`${appointments.expiresAt} > ${iso(now)}::timestamptz`,
          sql`${appointments.clientId} is distinct from ${String(client.id)}::bigint`,
        ),
      );
    if (Number(holds?.count ?? 0) >= MAX_PENDING_HOLDS) throw new SlotTakenError(PUBLIC_MESSAGES.slotTaken);

    let created;
    try {
      created = await createAppointment(tx, {
        locationId: location.id,
        serviceId: input.serviceId,
        staffId: input.staffId,
        start: input.start,
        clientId: client.id,
        source: "online",
        idempotencyKey: `online:${input.formId}`,
        createdBy: "online",
        now,
      });
    } catch (err) {
      if (err instanceof SlotTakenError) throw new SlotTakenError(PUBLIC_MESSAGES.slotTaken);
      throw err;
    }

    const [appt] = await tx
      .select({ clientId: appointments.clientId, status: appointments.status, expiresAt: appointments.expiresAt })
      .from(appointments)
      .where(and(eq(appointments.locationId, location.id), eq(appointments.id, created.appointmentId)));
    if (!appt || appt.clientId !== client.id) throw new BookingError(PUBLIC_MESSAGES.generic);
    if (appt.status !== "pending" || !appt.expiresAt || appt.expiresAt.getTime() <= now.getTime()) throw new BookingError(PUBLIC_MESSAGES.holdExpired);

    if (!created.created) {
      // Reintento del mismo formulario (doble toque, red): no se manda otro código.
      const [live] = await tx
        .select({ createdAt: bookingVerifications.createdAt })
        .from(bookingVerifications)
        .where(
          and(
            eq(bookingVerifications.appointmentId, created.appointmentId),
            isNull(bookingVerifications.consumedAt),
            isNull(bookingVerifications.supersededAt),
          ),
        );
      if (live) {
        return { send: null, holdExpiresAt: appt.expiresAt, resendAvailableAt: new Date(live.createdAt.getTime() + OTP_RESEND_COOLDOWN_SEC * 1000) };
      }
    }

    await assertCanSendCode(tx, ctx, { timeZone: location.timeZone, ipSubject: input.ipSubject, phone });
    const verification = await insertVerification(tx, {
      locationId: location.id,
      appointmentId: created.appointmentId,
      clientId: client.id,
      channel: "whatsapp",
      browserHash: input.browserHash,
      expiresAt: otpExpiry(now, appt.expiresAt),
      consentChoices: input.consents,
      consentTextVersion: CURRENT_PRIVACY_VERSION,
      consentIp: input.ip,
      consentUserAgent: input.userAgent,
      contactName: name,
      contactEmail: email,
      pepper: ctx.otpPepper,
    });
    const notificationId = await recordOtpAttempt(tx, {
      locationId: location.id,
      appointmentId: created.appointmentId,
      clientId: client.id,
      verificationId: verification.id,
      recipientHash: ctx.hash(phone),
    });
    return {
      send: { ...verification, notificationId },
      holdExpiresAt: appt.expiresAt,
      resendAvailableAt: new Date(now.getTime() + OTP_RESEND_COOLDOWN_SEC * 1000),
    };
  });

  // Después del COMMIT: el código en claro nunca queda en la base ni en la cola.
  if (result.send) await sendCode(db, ctx, notifier, { to: phone, code: result.send.code, verificationId: result.send.id, notificationId: result.send.notificationId });

  return {
    channel: "whatsapp",
    maskedDestination: maskPhone(phone),
    holdExpiresAt: result.holdExpiresAt,
    resendAvailableAt: result.resendAvailableAt,
  };
}

/** La verificación viva más reciente de este navegador en la sede, con su retención. */
async function liveVerification(db: Db, locationId: bigint, browserHash: string) {
  const [row] = await db
    .select({
      id: bookingVerifications.id,
      appointmentId: bookingVerifications.appointmentId,
      clientId: bookingVerifications.clientId,
      channel: bookingVerifications.channel,
      attempts: bookingVerifications.attempts,
      maxAttempts: bookingVerifications.maxAttempts,
      expiresAt: bookingVerifications.expiresAt,
      consentChoices: bookingVerifications.consentChoices,
      consentTextVersion: bookingVerifications.consentTextVersion,
      consentIp: bookingVerifications.consentIp,
      consentUserAgent: bookingVerifications.consentUserAgent,
      contactName: bookingVerifications.contactName,
      contactEmail: bookingVerifications.contactEmail,
      browserHash: bookingVerifications.browserHash,
      apptStatus: appointments.status,
      holdExpiresAt: appointments.expiresAt,
      phoneE164: clients.phoneE164,
    })
    .from(bookingVerifications)
    .innerJoin(
      appointments,
      and(eq(appointments.locationId, bookingVerifications.locationId), eq(appointments.id, bookingVerifications.appointmentId)),
    )
    .innerJoin(clients, and(eq(clients.locationId, bookingVerifications.locationId), eq(clients.id, bookingVerifications.clientId)))
    .where(
      and(
        eq(bookingVerifications.locationId, locationId),
        eq(bookingVerifications.browserHash, browserHash),
        isNull(bookingVerifications.consumedAt),
        isNull(bookingVerifications.supersededAt),
      ),
    )
    .orderBy(desc(bookingVerifications.id))
    .limit(1);
  return row;
}

const holdAlive = (v: { apptStatus: AppointmentStatus; holdExpiresAt: Date | null }, now: Date) =>
  v.apptStatus === "pending" && v.holdExpiresAt !== null && v.holdExpiresAt.getTime() > now.getTime();

/** Reenvío: 60 s de espera, máximo 3 envíos por retención; la retención no se alarga. */
export async function resendCode(
  db: Db,
  ctx: PublicBookingContext,
  input: { browserHash: string; ipSubject: string },
  notifier: Notifier,
): Promise<{ resendAvailableAt: Date; sendsLeft: number }> {
  const now = ctx.now;
  const live = await liveVerification(db, ctx.locationId, input.browserHash);
  if (!live || !holdAlive(live, now)) throw new BookingError(PUBLIC_MESSAGES.holdExpired);

  const [sends] = await db
    .select({ count: sql<number>`count(*)::int`, last: sql<string>`max(${bookingVerifications.createdAt})::text` })
    .from(bookingVerifications)
    .where(and(eq(bookingVerifications.locationId, ctx.locationId), eq(bookingVerifications.appointmentId, live.appointmentId)));
  const sendCount = Number(sends?.count ?? 0);
  const decision = canResendOtp({ sendCount, lastSentAt: new Date(sends?.last ?? 0) }, now);
  if (!decision.ok) {
    throw new BookingError(
      decision.reason === "cooldown"
        ? `Espera ${decision.waitSec} segundos para pedir otro código.`
        : `Ya te enviamos ${OTP_MAX_SENDS} códigos para esta reserva. Si no te llegan, escríbenos por WhatsApp.`,
    );
  }
  const to = live.phoneE164;
  if (!to || live.channel !== "whatsapp") throw new BookingError(PUBLIC_MESSAGES.holdExpired);
  const [loc] = await db.select({ timeZone: locations.timezone }).from(locations).where(eq(locations.id, ctx.locationId));

  const verification = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const superseded = await tx
      .update(bookingVerifications)
      .set({ supersededAt: now })
      .where(and(eq(bookingVerifications.id, live.id), isNull(bookingVerifications.consumedAt), isNull(bookingVerifications.supersededAt)))
      .returning({ id: bookingVerifications.id });
    if (superseded.length === 0) throw new BookingError(PUBLIC_MESSAGES.holdExpired);
    await assertCanSendCode(tx, ctx, { timeZone: loc?.timeZone ?? "America/Bogota", ipSubject: input.ipSubject, phone: to });
    const created = await insertVerification(tx, {
      locationId: ctx.locationId,
      appointmentId: live.appointmentId,
      clientId: live.clientId,
      channel: "whatsapp",
      browserHash: live.browserHash,
      expiresAt: otpExpiry(now, live.holdExpiresAt!),
      consentChoices: live.consentChoices,
      consentTextVersion: live.consentTextVersion,
      consentIp: live.consentIp,
      consentUserAgent: live.consentUserAgent,
      contactName: live.contactName,
      contactEmail: live.contactEmail,
      pepper: ctx.otpPepper,
    });
    const notificationId = await recordOtpAttempt(tx, {
      locationId: ctx.locationId,
      appointmentId: live.appointmentId,
      clientId: live.clientId,
      verificationId: created.id,
      recipientHash: ctx.hash(to),
    });
    return { ...created, notificationId };
  });
  await sendCode(db, ctx, notifier, { to, code: verification.code, verificationId: verification.id, notificationId: verification.notificationId });
  return { resendAvailableAt: new Date(now.getTime() + OTP_RESEND_COOLDOWN_SEC * 1000), sendsLeft: OTP_MAX_SENDS - (sendCount + 1) };
}

// ─── Verificar ───────────────────────────────────────────────────────────────

/** Comprueba el código y, si coincide, confirma la cita. Devuelve el token del enlace de gestión. */
export async function verifyBooking(db: Db, ctx: PublicBookingContext, input: { browserHash: string; code: string }): Promise<{ token: string }> {
  const now = ctx.now;
  const code = normalizeOtpInput(input.code);
  if (!code) throw new BookingError(PUBLIC_MESSAGES.codeShape);
  const live = await liveVerification(db, ctx.locationId, input.browserHash);
  if (!live) throw new BookingError(PUBLIC_MESSAGES.holdExpired);

  // 1. El intento se cuenta ANTES de comparar, con las condiciones en el mismo UPDATE.
  const [attempted] = await db
    .update(bookingVerifications)
    .set({ attempts: sql`${bookingVerifications.attempts} + 1` })
    .where(
      and(
        eq(bookingVerifications.id, live.id),
        sql`${bookingVerifications.attempts} < ${bookingVerifications.maxAttempts}`,
        isNull(bookingVerifications.consumedAt),
        isNull(bookingVerifications.supersededAt),
        sql`${bookingVerifications.expiresAt} > now()`,
      ),
    )
    .returning({ codeHash: bookingVerifications.codeHash, attempts: bookingVerifications.attempts, maxAttempts: bookingVerifications.maxAttempts });
  if (!attempted) {
    if (live.attempts >= live.maxAttempts) throw new BookingError(PUBLIC_MESSAGES.tooManyAttempts);
    if (!holdAlive(live, now)) throw new BookingError(PUBLIC_MESSAGES.holdExpired);
    throw new BookingError(PUBLIC_MESSAGES.codeExpired);
  }
  if (!otpMatches(ctx.otpPepper, live.id, code, Buffer.from(attempted.codeHash, "hex"))) {
    throw new BookingError(wrongCodeMessage(attempted.maxAttempts - attempted.attempts));
  }

  // 2. Coincide: todo en una transacción.
  const outcome = await db.transaction(async (txRaw): Promise<{ kind: "ok"; token: string } | { kind: "expired" } | { kind: "used" } | { kind: "limit"; max: number }> => {
    const tx = txRaw as unknown as Db;
    const [appt] = await tx
      .select({ id: appointments.id, publicId: appointments.publicId, status: appointments.status, expiresAt: appointments.expiresAt, during: appointments.during })
      .from(appointments)
      .where(and(eq(appointments.locationId, ctx.locationId), eq(appointments.id, live.appointmentId)))
      .for("update");
    if (!appt || !holdAlive({ apptStatus: appt.status, holdExpiresAt: appt.expiresAt }, now)) return { kind: "expired" };

    const consumed = await tx
      .update(bookingVerifications)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(bookingVerifications.id, live.id),
          isNull(bookingVerifications.consumedAt),
          isNull(bookingVerifications.supersededAt),
          sql`${bookingVerifications.expiresAt} > now()`,
        ),
      )
      .returning({ id: bookingVerifications.id });
    if (consumed.length === 0) return { kind: "used" };

    // Tope de citas futuras activas, con el cliente bloqueado para que dos verificaciones
    // simultáneas no pasen las dos.
    const [client] = await tx
      .select({ id: clients.id, phoneE164: clients.phoneE164, email: clients.email })
      .from(clients)
      .where(and(eq(clients.locationId, ctx.locationId), eq(clients.id, live.clientId)))
      .for("update");
    const [loc] = await tx.select({ max: locations.maxActivePerClient }).from(locations).where(eq(locations.id, ctx.locationId));
    const [active] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(appointments)
      .where(
        and(
          eq(appointments.locationId, ctx.locationId),
          eq(appointments.clientId, live.clientId),
          inArray(appointments.status, ["confirmed", "arrived", "in_chair"]),
          sql`upper(${appointments.during}) > ${iso(now)}::timestamptz`,
        ),
      );
    const max = loc?.max ?? 3;
    if (activeLimitReached(Number(active?.count ?? 0), max)) {
      await changeStatus(tx, {
        locationId: ctx.locationId,
        appointmentId: appt.id,
        to: "cancelled",
        actor: { kind: "system" },
        cancelReason: "duplicate",
        note: "Límite de citas activas del cliente",
        now,
      });
      return { kind: "limit", max };
    }

    await changeStatus(tx, { locationId: ctx.locationId, appointmentId: appt.id, to: "confirmed", actor: { kind: "system" }, now });
    await recordConsents(tx, {
      locationId: ctx.locationId,
      clientId: live.clientId,
      appointmentId: appt.id,
      choices: live.consentChoices,
      textVersion: live.consentTextVersion,
      ip: live.consentIp,
      userAgent: live.consentUserAgent,
      source: "online",
    });
    // El nombre escrito solo reemplaza al de un cliente que nació de una reserva en línea y
    // nunca se verificó (mismo instante que su primera verificación, sin citas del personal):
    // jamás el de un cliente verificado o creado en el panel.
    if (live.contactName) {
      await tx
        .update(clients)
        .set({ name: live.contactName, updatedAt: now })
        .where(
          and(
            eq(clients.locationId, ctx.locationId),
            eq(clients.id, live.clientId),
            isNull(clients.verifiedAt),
            isNull(clients.anonymizedAt),
            sql`${clients.createdAt} = (select min(bv.created_at) from booking_verifications bv
                 where bv.location_id = ${clients.locationId} and bv.client_id = ${clients.id})`,
            sql`not exists (select 1 from appointments a
                 where a.location_id = ${clients.locationId} and a.client_id = ${clients.id} and a.source <> 'online')`,
          ),
        );
    }
    // El correo escrito pasa al cliente solo ahora (celular comprobado) y solo si no tenía uno.
    if (live.contactEmail) {
      await tx
        .update(clients)
        .set({ email: live.contactEmail, updatedAt: now })
        .where(and(eq(clients.locationId, ctx.locationId), eq(clients.id, live.clientId), isNull(clients.email), isNull(clients.anonymizedAt)));
    }
    await tx
      .update(clients)
      .set({ verifiedAt: sql`coalesce(${clients.verifiedAt}, now())`, updatedAt: now })
      .where(and(eq(clients.locationId, ctx.locationId), eq(clients.id, live.clientId)));
    const token = await issueManageLink(tx, {
      locationId: ctx.locationId,
      appointmentId: appt.id,
      publicId: appt.publicId,
      appointmentEnd: appt.during.end,
      secret: ctx.manageLinkSecret,
    });
    // La confirmación va por el canal que se verificó.
    const to = live.channel === "whatsapp" ? client?.phoneE164 : client?.email;
    if (to) {
      await enqueueNotification(tx, {
        locationId: ctx.locationId,
        appointmentId: appt.id,
        clientId: live.clientId,
        channel: live.channel,
        template: "booking_confirmed",
        recipientHash: ctx.hash(to),
        dedupeKey: dedupeKey("confirm", appt.publicId),
        params: await messageParams(tx, { locationId: ctx.locationId, appointmentId: appt.id }),
      });
    }
    return { kind: "ok", token };
  });

  switch (outcome.kind) {
    case "ok":
      return { token: outcome.token };
    case "expired":
      throw new BookingError(PUBLIC_MESSAGES.holdExpired);
    case "used":
      throw new BookingError(PUBLIC_MESSAGES.codeUsed);
    case "limit":
      throw new BookingError(activeLimitMessage(outcome.max));
  }
}

// ─── Enlace de gestión: ver, cancelar, reprogramar ───────────────────────────

async function managedAppointment(db: Db, locationId: bigint, appointmentId: bigint, lock = false) {
  const q = db
    .select({
      id: appointments.id,
      publicId: appointments.publicId,
      status: appointments.status,
      during: appointments.during,
      durationMin: appointments.durationMin,
      bufferMin: appointments.bufferMin,
      price: appointments.price,
      serviceName: appointments.serviceName,
      serviceId: appointments.serviceId,
      staffId: appointments.staffId,
      clientId: appointments.clientId,
    })
    .from(appointments)
    .where(and(eq(appointments.locationId, locationId), eq(appointments.id, appointmentId)));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new BookingError(PUBLIC_MESSAGES.linkInvalid);
  return row;
}

async function clientReschedules(db: Db, locationId: bigint, appointmentId: bigint): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(appointmentEvents)
    .where(
      and(
        eq(appointmentEvents.locationId, locationId),
        eq(appointmentEvents.appointmentId, appointmentId),
        eq(appointmentEvents.kind, "rescheduled"),
        eq(appointmentEvents.actorKind, "client"),
      ),
    );
  return Number(row?.count ?? 0);
}

export interface TicketData {
  code: string;
  status: AppointmentStatus;
  statusLabel: string;
  serviceName: string;
  staffName: string;
  clientFirstName: string;
  dateLabel: string;
  timeLabel: string;
  durationMin: number;
  priceLabel: string;
  address: string | null;
  mapsUrl: string | null;
  startIso: string;
  endIso: string;
  serviceId: string;
  staffId: string;
  cancel: { allowed: boolean; late: boolean; freeCancelHours: number };
  reschedule: { allowed: boolean; reason: string | null };
  icsUrl: string;
}

/** El ticket de /cita/[token]; null para todo lo que no sirve (el mismo 404). */
export async function loadTicketData(db: Db, input: { location: PublicLocation; token: string; now: Date }): Promise<(TicketData & { publicId: string }) | null> {
  const link = await findByManageToken(db, { locationId: input.location.id, token: input.token, now: input.now });
  if (!link) return null;
  const [row] = await db
    .select({
      publicId: appointments.publicId,
      status: appointments.status,
      during: appointments.during,
      durationMin: appointments.durationMin,
      price: appointments.price,
      serviceName: appointments.serviceName,
      servicePublicId: services.publicId,
      staffName: staffMembers.displayName,
      staffPublicId: staffMembers.publicId,
      clientName: clients.name,
    })
    .from(appointments)
    .innerJoin(services, and(eq(services.locationId, appointments.locationId), eq(services.id, appointments.serviceId)))
    .innerJoin(staffMembers, and(eq(staffMembers.locationId, appointments.locationId), eq(staffMembers.id, appointments.staffId)))
    .leftJoin(clients, and(eq(clients.locationId, appointments.locationId), eq(clients.id, appointments.clientId)))
    .where(and(eq(appointments.locationId, input.location.id), eq(appointments.id, link.appointmentId)));
  if (!row) return null;

  const tz = input.location.timeZone;
  const start = row.during.start;
  const end = new Date(start.getTime() + row.durationMin * MINUTE_MS);
  const view = { status: row.status, start };
  const cancel = clientCanCancel(view, input.now, input.location.freeCancelHours);
  const reschedule = clientCanReschedule(view, input.now, input.location.freeCancelHours, await clientReschedules(db, input.location.id, link.appointmentId));
  return {
    publicId: row.publicId,
    code: ticketCode(row.publicId),
    status: row.status,
    statusLabel: PUBLIC_STATUS_LABELS[row.status],
    serviceName: row.serviceName,
    staffName: row.staffName,
    clientFirstName: firstNameForMessage(row.clientName ?? ""),
    ...instantLabels(start, tz),
    durationMin: row.durationMin,
    priceLabel: format(money(row.price)),
    address: input.location.address,
    mapsUrl: input.location.mapsUrl,
    startIso: iso(start),
    endIso: iso(end),
    serviceId: row.servicePublicId,
    staffId: row.staffPublicId,
    cancel: { allowed: cancel.ok, late: cancel.ok && cancel.late, freeCancelHours: input.location.freeCancelHours },
    reschedule: { allowed: reschedule.ok, reason: reschedule.ok ? null : decisionMessage(reschedule, input.location.freeCancelHours) },
    icsUrl: `/cita/${input.token}/calendario.ics`,
  };
}

/** Lo que el enlace permite ver para reprogramar: la cita y su servicio/barbero (o el error). */
export async function rescheduleTarget(db: Db, input: { location: PublicLocation; token: string; now: Date }) {
  const link = await findByManageToken(db, { locationId: input.location.id, token: input.token, now: input.now });
  if (!link) throw new BookingError(PUBLIC_MESSAGES.linkInvalid);
  const appt = await managedAppointment(db, input.location.id, link.appointmentId);
  const d = clientCanReschedule(
    { status: appt.status, start: appt.during.start },
    input.now,
    input.location.freeCancelHours,
    await clientReschedules(db, input.location.id, appt.id),
  );
  if (!d.ok) throw new BookingError(decisionMessage(d, input.location.freeCancelHours));
  return appt;
}

/** Cancelar desde el enlace. Cancelar dos veces no hace nada la segunda. */
export async function cancelByClient(db: Db, ctx: PublicBookingContext, location: PublicLocation, input: { token: string; reason?: string }): Promise<void> {
  const now = ctx.now;
  const link = await findByManageToken(db, { locationId: location.id, token: input.token, now, allowRevoked: true });
  if (!link) throw new BookingError(PUBLIC_MESSAGES.linkInvalid);

  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const appt = await managedAppointment(tx, location.id, link.appointmentId, true);
    if (appt.status === "cancelled") return; // ya estaba: no-op
    if (link.revoked) throw new BookingError(PUBLIC_MESSAGES.linkInvalid);
    const d = clientCanCancel({ status: appt.status, start: appt.during.start }, now, location.freeCancelHours);
    if (!d.ok) throw new BookingError(decisionMessage(d, location.freeCancelHours));

    await changeStatus(tx, {
      locationId: location.id,
      appointmentId: appt.id,
      to: "cancelled",
      actor: { kind: "client" },
      cancelReason: "client",
      note: input.reason?.trim().slice(0, 200),
      now,
    });
    await revokeManageLinks(tx, { locationId: location.id, appointmentId: appt.id, reason: "cancelled", now });

    if (appt.clientId !== null) {
      const [client] = await tx
        .select({ phoneE164: clients.phoneE164, email: clients.email, anonymizedAt: clients.anonymizedAt })
        .from(clients)
        .where(and(eq(clients.locationId, location.id), eq(clients.id, appt.clientId)));
      const target = client && !client.anonymizedAt ? preferredChannel(client, ctx.channels) : null;
      if (target) {
        await enqueueNotification(tx, {
          locationId: location.id,
          appointmentId: appt.id,
          clientId: appt.clientId,
          channel: target.channel,
          template: "appointment_cancelled_client",
          recipientHash: ctx.hash(target.to),
          dedupeKey: dedupeKey("cancel", appt.publicId),
          params: await messageParams(tx, { locationId: location.id, appointmentId: appt.id }),
        });
      }
    }
  });
}

/** Reprogramar desde el enlace: mismo barbero, horario ofrecido en línea, máximo 2 veces. */
export async function rescheduleByClient(
  db: Db,
  ctx: PublicBookingContext,
  location: PublicLocation,
  input: { token: string; date: string; minute: number },
): Promise<{ dateLabel: string; timeLabel: string }> {
  const now = ctx.now;
  assertBookableDate(location, input.date, now);
  const appt = await rescheduleTarget(db, { location, token: input.token, now });
  const start = localMinuteToInstant(input.date, input.minute, location.timeZone);
  if (start.getTime() === appt.during.start.getTime()) throw new BookingError(PUBLIC_MESSAGES.sameTime);
  await assertSlotOffered(db, { location, serviceId: appt.serviceId, staffId: appt.staffId, start, now, excludeAppointmentId: appt.id });

  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Otra vez, con la cita bloqueada: dos reprogramaciones simultáneas no pasan las dos el tope.
    const locked = await managedAppointment(tx, location.id, appt.id, true);
    const d = clientCanReschedule(
      { status: locked.status, start: locked.during.start },
      now,
      location.freeCancelHours,
      await clientReschedules(tx, location.id, appt.id),
    );
    if (!d.ok) throw new BookingError(decisionMessage(d, location.freeCancelHours));
    if (start.getTime() === locked.during.start.getTime()) throw new BookingError(PUBLIC_MESSAGES.sameTime);
    try {
      await rescheduleAppointment(tx, { locationId: location.id, appointmentId: appt.id, start, staffId: appt.staffId, actor: { kind: "client" }, now });
    } catch (err) {
      if (err instanceof SlotTakenError) throw new SlotTakenError(PUBLIC_MESSAGES.slotTaken);
      throw err;
    }
    // rescheduleAppointment ya alargó el enlace al nuevo fin.
    if (appt.clientId !== null) {
      const [client] = await tx
        .select({ phoneE164: clients.phoneE164, email: clients.email, anonymizedAt: clients.anonymizedAt })
        .from(clients)
        .where(and(eq(clients.locationId, location.id), eq(clients.id, appt.clientId)));
      const target = client && !client.anonymizedAt ? preferredChannel(client, ctx.channels) : null;
      if (target) {
        await enqueueNotification(tx, {
          locationId: location.id,
          appointmentId: appt.id,
          clientId: appt.clientId,
          channel: target.channel,
          template: "appointment_rescheduled",
          recipientHash: ctx.hash(target.to),
          dedupeKey: dedupeKey("resched", appt.publicId, start),
          params: await messageParams(tx, { locationId: location.id, appointmentId: appt.id }),
        });
      }
    }
  });
  return instantLabels(start, location.timeZone);
}

// ─── Portada ─────────────────────────────────────────────────────────────────

export interface PortalData {
  location: { name: string; address: string | null; mapsUrl: string | null; publicPhone: string | null; whatsappUrl: string | null };
  services: { id: string; name: string; durationMin: number; priceLabel: string }[];
  staff: { id: string; name: string; initials: string }[];
  hours: { weekday: Weekday; label: string; ranges: string[] }[];
  today: string;
  maxAdvanceDays: number;
  holdMin: number;
}

export async function loadPortalData(db: Db, location: PublicLocation, now: Date): Promise<PortalData> {
  const serviceRows = await db
    .select({ id: services.publicId, name: services.name, durationMin: services.durationMin, price: services.price })
    .from(services)
    .where(and(eq(services.locationId, location.id), eq(services.active, true)))
    .orderBy(asc(services.name));

  const scheduleRows = await db
    .select({
      staffId: staffMembers.id,
      publicId: staffMembers.publicId,
      name: staffMembers.displayName,
      bookableOnline: staffMembers.bookableOnline,
      weekday: staffSchedules.weekday,
      startMin: staffSchedules.startMin,
      endMin: staffSchedules.endMin,
    })
    .from(staffMembers)
    .innerJoin(staffSchedules, and(eq(staffSchedules.locationId, staffMembers.locationId), eq(staffSchedules.staffId, staffMembers.id)))
    .where(and(eq(staffMembers.locationId, location.id), eq(staffMembers.active, true)))
    .orderBy(asc(staffMembers.displayName), asc(staffMembers.id));

  const staff = new Map<bigint, { id: string; name: string; initials: string }>();
  for (const r of scheduleRows) {
    if (r.bookableOnline && !staff.has(r.staffId)) staff.set(r.staffId, { id: r.publicId, name: r.name, initials: initials(r.name) });
  }
  const hours = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => {
    const ranges = merge(scheduleRows.filter((r) => r.weekday === weekday).map((r) => ({ start: r.startMin, end: r.endMin })));
    return { weekday, label: WEEKDAY_LABELS[weekday], ranges: ranges.map((r) => `${formatClock(r.start)} – ${formatClock(r.end)}`) };
  });

  const phone = location.publicPhone ? normalizePhone(location.publicPhone) : null;
  return {
    location: {
      name: location.name,
      address: location.address,
      mapsUrl: location.mapsUrl,
      publicPhone: location.publicPhone,
      whatsappUrl: phone ? `https://wa.me/${phone.slice(1)}` : null,
    },
    services: serviceRows.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, priceLabel: format(money(s.price)) })),
    staff: [...staff.values()],
    hours,
    today: businessDate(now, location.timeZone),
    maxAdvanceDays: location.maxAdvanceDays,
    holdMin: location.holdMin,
  };
}
