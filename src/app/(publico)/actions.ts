"use server";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { db } from "@/db/client";
import {
  assertBookableDate,
  cancelByClient,
  hashBrowserCookie,
  PUBLIC_MESSAGES,
  type PublicBookingContext,
  type PublicLocation,
  publicDaySummary,
  publicLocation,
  publicMobile,
  publicSlots,
  rescheduleByClient,
  rescheduleTarget,
  resendCode as resendBookingCode,
  resolveServiceId,
  resolveStaffId,
  type SlotView,
  startOnlineBooking,
  verifyBooking,
} from "@/db/public-booking";
import { enforce } from "@/db/rate-limit";
import type { Db } from "@/db/types";
import { BookingError } from "@/domain/booking/appointment";
import { isDateString, localMinuteToInstant } from "@/domain/booking/clock";
import { assertValidClientName, InvalidClientError } from "@/domain/clients/client";
import { assertBookingConsent } from "@/domain/clients/consent";
import type { NotificationChannel } from "@/domain/notifications/templates";
import { type ActionResult, runAction } from "@/lib/action";
import { clientIp, clientUserAgent, hashForBucket, ipBucketKey } from "@/lib/client-ip";
import { alertSender, notifier } from "@/lib/notify";
import { allowsDevFallbacks, type PublicConfig, publicConfig, PublicBookingUnavailableError } from "@/lib/public-readiness";
import { humanVerifier } from "@/lib/turnstile";

// Acciones del portal público (contrato de sprint-3-reserva-publica.md §10). Delgadas: validan
// la forma con zod, toman la sede del servidor (nunca del navegador), aplican Turnstile y los
// límites por IP, y llaman a src/db/public-booking.ts. Los mensajes salen tal cual a la interfaz.
// Las lecturas de horarios también tienen límite ("browse") y rechazan fechas fuera del
// horizonte antes de consultar: cada una calcula disponibilidad.

const database = () => db() as unknown as Db;

const HOLD_COOKIE = "villa_hold";
const HOLD_COOKIE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const uuid = z.uuid("Identificador inválido");
const staffChoice = z.union([z.literal("any"), uuid]);
const dateSchema = z.string().refine(isDateString, "Fecha inválida");
const minuteSchema = z.number().int().min(0).max(24 * 60 - 1);
const tokenSchema = z.string().max(100);

interface Scope {
  location: PublicLocation;
  config: PublicConfig;
  ctx: PublicBookingContext;
}

function scopeOf(location: PublicLocation, config: PublicConfig): Scope {
  return {
    location,
    config,
    ctx: {
      locationId: location.id,
      now: new Date(),
      otpPepper: config.otpPepper,
      manageLinkSecret: config.manageLinkSecret,
      channels: config.channels,
      hash: (value) => hashForBucket(value, config.otpPepper),
      caps: config.caps,
      alert: alertSender(),
    },
  };
}

/** Reservar: la sede pública con la reserva activa y la configuración lista (falla cerrado). */
async function bookingScope(): Promise<Scope> {
  const location = await publicLocation(database());
  if (!location?.publicBookingEnabled) throw new PublicBookingUnavailableError();
  return scopeOf(location, publicConfig());
}

/** Gestionar una cita ya hecha: sirve aunque el dueño haya apagado la reserva. */
async function manageScope(): Promise<Scope> {
  const location = await publicLocation(database(), { fallbackToFirst: true });
  if (!location) throw new BookingError(PUBLIC_MESSAGES.linkInvalid);
  return scopeOf(location, publicConfig());
}

async function ipSubject(scope: Scope): Promise<{ ip: string | null; hash: string }> {
  const ip = await clientIp();
  // IPv6 por /64 (ipBucketKey). Sin IP confiable (proxy mal configurado) todos comparten la
  // cubeta: falla cerrado.
  return { ip, hash: scope.ctx.hash(`ip:${ip ? ipBucketKey(ip) : "desconocida"}`) };
}

/** Límite de lecturas de horarios por IP. */
async function enforceBrowse(scope: Scope): Promise<void> {
  const { hash } = await ipSubject(scope);
  await enforce(database(), "browse", { ip: hash }, scope.ctx.now);
}

async function staffIdOf(scope: Scope, staffId: string): Promise<bigint | "any"> {
  return staffId === "any" ? "any" : resolveStaffId(database(), scope.location.id, staffId);
}

async function holdCookie(): Promise<string | null> {
  const value = (await cookies()).get(HOLD_COOKIE)?.value;
  return value && HOLD_COOKIE_SHAPE.test(value) ? value : null;
}

// ─── Horarios ────────────────────────────────────────────────────────────────

const summaryInput = z.object({ serviceId: uuid, staffId: staffChoice });

export async function loadDaySummary(raw: { serviceId: string; staffId: string | "any" }): Promise<ActionResult<{ days: { date: string; count: number; closed: boolean }[] }>> {
  return runAction(async () => {
    const input = summaryInput.parse(raw);
    const scope = await bookingScope();
    await enforceBrowse(scope);
    const days = await publicDaySummary(database(), {
      location: scope.location,
      serviceId: await resolveServiceId(database(), scope.location.id, input.serviceId),
      staffId: await staffIdOf(scope, input.staffId),
      now: scope.ctx.now,
    });
    return { days };
  });
}

const slotsInput = z.object({ serviceId: uuid, staffId: staffChoice, date: dateSchema });

export async function loadPublicSlots(raw: { serviceId: string; staffId: string | "any"; date: string }): Promise<ActionResult<{ slots: SlotView[] }>> {
  return runAction(async () => {
    const input = slotsInput.parse(raw);
    const scope = await bookingScope();
    assertBookableDate(scope.location, input.date, scope.ctx.now);
    await enforceBrowse(scope);
    const slots = await publicSlots(database(), {
      location: scope.location,
      serviceId: await resolveServiceId(database(), scope.location.id, input.serviceId),
      staffId: await staffIdOf(scope, input.staffId),
      date: input.date,
      now: scope.ctx.now,
    });
    return { slots };
  });
}

// ─── Reservar y verificar ────────────────────────────────────────────────────

const startInput = z.object({
  serviceId: uuid,
  staffId: staffChoice,
  date: dateSchema,
  minute: minuteSchema,
  name: z.string().max(120),
  phone: z.string().max(30),
  email: z.union([z.literal(""), z.email("El correo no es válido")]).optional(),
  consents: z.object({ dataProcessing: z.boolean(), reminders: z.boolean(), marketing: z.boolean() }),
  turnstileToken: z.string().max(2048),
  formId: uuid,
});

export async function startBooking(raw: z.input<typeof startInput>): Promise<
  ActionResult<{ channel: NotificationChannel; maskedDestination: string; holdExpiresAt: string; resendAvailableAt: string }>
> {
  return runAction(async () => {
    const input = startInput.parse(raw);
    // Lo que se puede validar sin gastar el token de Turnstile ni escribir nada.
    assertBookingConsent(input.consents);
    assertValidClientName(input.name);
    if (!publicMobile(input.phone)) throw new InvalidClientError(PUBLIC_MESSAGES.phone);
    const scope = await bookingScope();
    assertBookableDate(scope.location, input.date, scope.ctx.now);

    const { ip, hash } = await ipSubject(scope);
    if (!(await humanVerifier().verify(input.turnstileToken, ip))) {
      throw new BookingError("No pudimos comprobar que eres una persona. Recarga la página e inténtalo otra vez.");
    }
    await enforce(database(), "booking_start", { ip: hash }, scope.ctx.now);
    // Los límites de envío (IP, celular y sede) se cuentan dentro de startOnlineBooking, solo si
    // de verdad se va a enviar un código.

    const cookie = (await holdCookie()) ?? randomBytes(32).toString("base64url");
    const result = await startOnlineBooking(
      database(),
      scope.ctx,
      scope.location,
      {
        serviceId: await resolveServiceId(database(), scope.location.id, input.serviceId),
        staffId: await staffIdOf(scope, input.staffId),
        start: localMinuteToInstant(input.date, input.minute, scope.location.timeZone),
        name: input.name,
        phone: input.phone,
        email: input.email || null,
        consents: input.consents,
        formId: input.formId,
        browserHash: hashBrowserCookie(cookie),
        ip,
        ipSubject: hash,
        userAgent: await clientUserAgent(),
      },
      notifier(),
    );
    (await cookies()).set(HOLD_COOKIE, cookie, {
      httpOnly: true,
      secure: !allowsDevFallbacks(),
      sameSite: "strict",
      path: "/reservar",
      maxAge: (scope.location.holdMin + 5) * 60,
    });
    return {
      channel: result.channel,
      maskedDestination: result.maskedDestination,
      holdExpiresAt: result.holdExpiresAt.toISOString(),
      resendAvailableAt: result.resendAvailableAt.toISOString(),
    };
  });
}

export async function resendCode(): Promise<ActionResult<{ resendAvailableAt: string; sendsLeft: number }>> {
  return runAction(async () => {
    const scope = await bookingScope();
    const cookie = await holdCookie();
    if (!cookie) throw new BookingError(PUBLIC_MESSAGES.holdExpired);
    const { hash } = await ipSubject(scope);
    const result = await resendBookingCode(database(), scope.ctx, { browserHash: hashBrowserCookie(cookie), ipSubject: hash }, notifier());
    return { resendAvailableAt: result.resendAvailableAt.toISOString(), sendsLeft: result.sendsLeft };
  });
}

const verifyInput = z.object({ code: z.string().max(20) });

export async function verifyCode(raw: { code: string }): Promise<ActionResult<{ manageUrl: string }>> {
  return runAction(async () => {
    const input = verifyInput.parse(raw);
    const scope = await bookingScope();
    const cookie = await holdCookie();
    if (!cookie) throw new BookingError(PUBLIC_MESSAGES.holdExpired);
    const { hash } = await ipSubject(scope);
    await enforce(database(), "otp_verify", { ip: hash }, scope.ctx.now);
    const { token } = await verifyBooking(database(), scope.ctx, { browserHash: hashBrowserCookie(cookie), code: input.code });
    (await cookies()).delete({ name: HOLD_COOKIE, path: "/reservar" });
    return { manageUrl: `/cita/${token}` };
  });
}

// ─── Gestionar la cita (/cita/[token]) ───────────────────────────────────────

const cancelInput = z.object({ token: tokenSchema, reason: z.string().max(200).optional() });

export async function cancelByToken(raw: { token: string; reason?: string }): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const input = cancelInput.parse(raw);
    const scope = await manageScope();
    const { hash } = await ipSubject(scope);
    await enforce(database(), "manage_action", { ip: hash }, scope.ctx.now);
    await cancelByClient(database(), scope.ctx, scope.location, input);
    return undefined;
  });
}

const rescheduleDaysInput = z.object({ token: tokenSchema });

export async function loadRescheduleDays(raw: { token: string }): Promise<ActionResult<{ days: { date: string; count: number; closed: boolean }[] }>> {
  return runAction(async () => {
    const input = rescheduleDaysInput.parse(raw);
    const scope = await manageScope();
    await enforceBrowse(scope);
    const appt = await rescheduleTarget(database(), { location: scope.location, token: input.token, now: scope.ctx.now });
    const days = await publicDaySummary(database(), {
      location: scope.location,
      serviceId: appt.serviceId,
      staffId: appt.staffId,
      now: scope.ctx.now,
      excludeAppointmentId: appt.id,
    });
    return { days };
  });
}

const rescheduleSlotsInput = z.object({ token: tokenSchema, date: dateSchema });

export async function loadRescheduleSlots(raw: { token: string; date: string }): Promise<ActionResult<{ slots: SlotView[] }>> {
  return runAction(async () => {
    const input = rescheduleSlotsInput.parse(raw);
    const scope = await manageScope();
    assertBookableDate(scope.location, input.date, scope.ctx.now);
    await enforceBrowse(scope);
    const appt = await rescheduleTarget(database(), { location: scope.location, token: input.token, now: scope.ctx.now });
    const slots = await publicSlots(database(), {
      location: scope.location,
      serviceId: appt.serviceId,
      staffId: appt.staffId,
      date: input.date,
      now: scope.ctx.now,
      excludeAppointmentId: appt.id,
    });
    return { slots };
  });
}

const rescheduleInput = z.object({ token: tokenSchema, date: dateSchema, minute: minuteSchema });

export async function rescheduleByToken(raw: { token: string; date: string; minute: number }): Promise<ActionResult<{ dateLabel: string; timeLabel: string }>> {
  return runAction(async () => {
    const input = rescheduleInput.parse(raw);
    const scope = await manageScope();
    const { hash } = await ipSubject(scope);
    await enforce(database(), "manage_action", { ip: hash }, scope.ctx.now);
    return rescheduleByClient(database(), scope.ctx, scope.location, input);
  });
}
