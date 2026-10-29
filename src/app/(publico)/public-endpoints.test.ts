import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppointment } from "@/db/appointments";
import { createService } from "@/db/catalog";
import { findOrCreateClient } from "@/db/clients";
import { createLocation } from "@/db/ledger";
import { issueManageLink } from "@/db/manage-links";
import { MAX_PENDING_HOLDS, PUBLIC_MESSAGES } from "@/db/public-booking";
import { enforce } from "@/db/rate-limit";
import { appointmentLinks, appointments, bookingVerifications, clientConsents, clients, locations, notificationEvents, notifications, services, staffMembers } from "@/db/schema";
import { addStaffMember, setWeeklySchedule } from "@/db/staff";
import { createTestDb } from "@/db/testing";
import { addTimeOff } from "@/db/time-off";
import type { Db } from "@/db/types";
import { addDays, localMinuteToInstant, MINUTE_MS } from "@/domain/booking/clock";
import { localParts } from "@/domain/booking/public-labels";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { MemoryNotifier } from "@/lib/notify/memory";
import { ipBucketKey } from "@/lib/client-ip";
import { bucketHash, DEV_ONLY_MANAGE_LINK_SECRET, DEV_ONLY_OTP_PEPPER } from "@/lib/public-readiness";

// Superficie pública (sprint-3-reserva-publica.md §6): cada server action de (publico)/actions.ts
// contra un PostgreSQL en memoria, con el verificador falso ("ok") y el notificador en memoria.
// Se simulan las cabeceras (IP), las cookies del navegador y next/navigation.

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  notifier: undefined as unknown,
  ip: "10.0.0.1",
  /** Cookies del "navegador" actual. Cambiar de Map = cambiar de navegador. */
  jar: new Map<string, string>(),
  cookieOptions: undefined as unknown,
  /** Asuntos de los avisos al dueño (ALERT_EMAIL). */
  alerts: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`redirect ${url}`), { url, digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
  notFound: () => {
    throw Object.assign(new Error("not found"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": `${state.ip}, 127.0.0.1`, "user-agent": "vitest" }),
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
    set: (name: string, value: string, options: unknown) => {
      state.jar.set(name, value);
      state.cookieOptions = options;
    },
    delete: (arg: string | { name: string }) => {
      state.jar.delete(typeof arg === "string" ? arg : arg.name);
    },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: <T>(fn: T) => fn }));
vi.mock("@/db/client", () => ({ db: () => state.db }));
vi.mock("@/lib/notify", () => ({
  notifier: () => state.notifier,
  alertSender: () => async (subject: string) => {
    state.alerts.push(subject);
  },
}));

const actions = await import("./actions");
const data = await import("./data");
const ics = await import("./cita/[token]/calendario.ics/route");

const TZ = "America/Bogota";
let db: Db;
let client: PGlite;
let notifier: MemoryNotifier;
const A = {} as { location: bigint; barber: bigint; barberPublic: string; service: bigint; servicePublic: string };
const B = {} as { location: bigint; service: bigint; barber: bigint };

let today: string;
let k = 0;
/** Un horario distinto en cada llamada, dentro de la anticipación máxima. */
function nextSlot() {
  const i = k++;
  return { date: addDays(today, 2 + Math.floor(i / 20)), minute: 6 * 60 + (i % 20) * 45 };
}
let phones = 0;
const newPhone = () => `3${String(++phones).padStart(9, "0")}`;
const e164 = (phone: string) => `+57${phone}`;
let ips = 0;
function newIp() {
  ips++;
  state.ip = `10.1.${Math.floor(ips / 250)}.${(ips % 250) + 1}`;
}
const newBrowser = () => {
  state.jar = new Map();
};

function startInput(phone: string, over: Partial<Parameters<typeof actions.startBooking>[0]> = {}) {
  const { date, minute } = nextSlot();
  return {
    serviceId: A.servicePublic,
    staffId: A.barberPublic,
    date,
    minute,
    name: "Ana María",
    phone,
    consents: { dataProcessing: true, reminders: true, marketing: false },
    turnstileToken: "ok",
    formId: randomUUID(),
    ...over,
  };
}

/** Reserva y verifica; devuelve el token del enlace de gestión. */
async function bookAndVerify(phone = newPhone()): Promise<string> {
  newBrowser();
  const started = await actions.startBooking(startInput(phone));
  expect(started.ok, JSON.stringify(started)).toBe(true);
  const verified = await actions.verifyCode({ code: notifier.lastCode(e164(phone))! });
  expect(verified.ok, JSON.stringify(verified)).toBe(true);
  return (verified as { ok: true; data: { manageUrl: string } }).data.manageUrl.replace("/cita/", "");
}

async function appointmentByToken(token: string) {
  const { hashManageToken } = await import("@/domain/links/manage-token");
  const [row] = await db
    .select({ id: appointments.id, status: appointments.status, during: appointments.during, revokedAt: appointmentLinks.revokedAt })
    .from(appointmentLinks)
    .innerJoin(appointments, eq(appointments.id, appointmentLinks.appointmentId))
    .where(eq(appointmentLinks.tokenHash, hashManageToken(token).toString("hex")));
  return row!;
}

/** El sujeto del límite por IP tal como lo calcula la acción (IPv6 por /64). */
const ipSubjectOf = (ip: string) => bucketHash(`ip:${ipBucketKey(ip)}`, DEV_ONLY_OTP_PEPPER);

/** Si faltan menos de 5 s para cambiar de hora, espera: los límites son de ventana fija por hora. */
async function awayFromHourEdge() {
  const left = 3_600_000 - (Date.now() % 3_600_000);
  if (left < 5_000) await new Promise((r) => setTimeout(r, left + 50));
}

async function otpSendHits(): Promise<number> {
  const result: unknown = await db.execute(sql`select coalesce(sum(hits), 0)::int as n from rate_limit_counters where bucket like 'otp_send:%'`);
  const list = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as { n: number }[];
  return Number(list[0]?.n ?? 0);
}

async function clientRow(phone: string) {
  const [row] = await db.select({ id: clients.id, name: clients.name, email: clients.email }).from(clients).where(eq(clients.phoneE164, e164(phone)));
  return row!;
}

/** Lo que una reserva retiene o registra (sin los contadores de límites). */
async function heldAndSent(): Promise<string> {
  return JSON.stringify([await db.$count(appointments), await db.$count(bookingVerifications), await db.$count(notifications)]);
}

/** Huella de lo que una reserva podría escribir. */
async function fingerprint(): Promise<string> {
  const rows = await db.execute(sql`
    select (select count(*) from clients) as clients, (select count(*) from appointments) as appointments,
           (select count(*) from booking_verifications) as verifications, (select coalesce(sum(hits), 0) from rate_limit_counters) as hits,
           (select count(*) from notifications) as notifications`);
  return JSON.stringify(rows);
}

beforeAll(async () => {
  // Sin variables públicas: secretos de desarrollo, verificador falso y canales de consola.
  for (const name of ["OTP_PEPPER", "MANAGE_LINK_SECRET", "PUBLIC_BASE_URL", "TURNSTILE_SECRET", "NEXT_PUBLIC_TURNSTILE_SITE_KEY", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "RESEND_API_KEY", "EMAIL_FROM"]) {
    vi.stubEnv(name, "");
  }
  ({ db, client } = await createTestDb());
  state.db = db;
  notifier = new MemoryNotifier();
  state.notifier = notifier;
  today = businessDate(new Date(), TZ);
  const allDay = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: 0, endMin: 1440 }));

  A.location = await createLocation(db, { name: "Villa" });
  await db.update(locations).set({ publicBookingEnabled: true, address: "Calle 10 # 5-20", publicPhone: "300 555 1234" }).where(eq(locations.id, A.location));
  A.barber = await addStaffMember(db, { locationId: A.location, displayName: "Andrés Gómez", role: "barber" });
  await setWeeklySchedule(db, { locationId: A.location, staffId: A.barber, blocks: allDay });
  const owner = await addStaffMember(db, { locationId: A.location, displayName: "Dueño", role: "owner" });
  await setWeeklySchedule(db, { locationId: A.location, staffId: owner, blocks: allDay });
  await db.update(staffMembers).set({ bookableOnline: false }).where(eq(staffMembers.id, owner));
  A.service = (
    await createService(db, { locationId: A.location, draft: { name: "Corte", durationMin: 30, bufferMin: 10, price: fromUnits(35_000n), commissionBps: 4_000 } })
  ).id;
  [{ barberPublic: A.barberPublic }] = await db.select({ barberPublic: staffMembers.publicId }).from(staffMembers).where(eq(staffMembers.id, A.barber)) as [{ barberPublic: string }];
  [{ servicePublic: A.servicePublic }] = await db.select({ servicePublic: services.publicId }).from(services).where(eq(services.id, A.service)) as [{ servicePublic: string }];

  B.location = await createLocation(db, { name: "Otra sede" });
  B.barber = await addStaffMember(db, { locationId: B.location, displayName: "Barbero B", role: "barber" });
  await setWeeklySchedule(db, { locationId: B.location, staffId: B.barber, blocks: allDay });
  B.service = (
    await createService(db, { locationId: B.location, draft: { name: "Corte B", durationMin: 30, bufferMin: 0, price: fromUnits(20_000n), commissionBps: 4_000 } })
  ).id;
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await client?.close();
});

// ─── Casos por acción ────────────────────────────────────────────────────────

interface Case {
  /** La server action que se prueba (ver la guarda de completitud al final). */
  action: string;
  name: string;
  run: () => Promise<void>;
}

const CASES: Case[] = [
  {
    action: "loadDaySummary",
    name: "cuenta horarios por día desde hoy, solo con barberos en línea",
    run: async () => {
      const r = await actions.loadDaySummary({ serviceId: A.servicePublic, staffId: "any" });
      if (!r.ok) throw new Error(r.error);
      expect(r.data.days).toHaveLength(14);
      expect(r.data.days[0]!.date).toBe(today);
      expect(r.data.days[3]!.count).toBeGreaterThan(0);
      expect(r.data.days[3]!.closed).toBe(false);
      // Un festivo de toda la sede: "Cerrado", no "Lleno".
      const holiday = addDays(today, 13);
      await addTimeOff(db, { locationId: A.location, staffId: null, kind: "block", createdBy: "seed", allDay: true, fromDate: holiday, toDate: holiday });
      const after = await actions.loadDaySummary({ serviceId: A.servicePublic, staffId: "any" });
      if (!after.ok) throw new Error(after.error);
      expect(after.data.days[13]).toEqual({ date: holiday, count: 0, closed: true });
      const bad = await actions.loadDaySummary({ serviceId: "1", staffId: "any" });
      expect(bad).toEqual({ ok: false, error: "Identificador inválido" });
    },
  },
  {
    action: "loadPublicSlots",
    name: "da horarios con etiqueta y periodo; el dueño (no en línea) no se ofrece",
    run: async () => {
      const date = addDays(today, 5);
      const r = await actions.loadPublicSlots({ serviceId: A.servicePublic, staffId: A.barberPublic, date });
      if (!r.ok) throw new Error(r.error);
      expect(r.data.slots.find((s) => s.minute === 15 * 60 + 30)).toEqual({ minute: 930, label: "3:30 p. m.", period: "afternoon" });
      const [{ ownerPublic }] = (await db.select({ ownerPublic: staffMembers.publicId }).from(staffMembers).where(eq(staffMembers.displayName, "Dueño"))) as [{ ownerPublic: string }];
      expect(await actions.loadPublicSlots({ serviceId: A.servicePublic, staffId: ownerPublic, date })).toMatchObject({ ok: false });
    },
  },
  {
    action: "loadPublicSlots",
    name: "fechas fuera de [hoy, hoy + días de anticipación] se rechazan antes de consultar",
    run: async () => {
      newIp();
      for (const date of [addDays(today, -1), addDays(today, 15), "2099-01-01"]) {
        expect(await actions.loadPublicSlots({ serviceId: A.servicePublic, staffId: "any", date })).toEqual({ ok: false, error: PUBLIC_MESSAGES.dateOutOfRange });
      }
      expect((await actions.loadPublicSlots({ serviceId: A.servicePublic, staffId: "any", date: addDays(today, 14) })).ok).toBe(true);
    },
  },
  {
    action: "loadDaySummary",
    name: "las lecturas de horarios tienen límite por IP (browse)",
    run: async () => {
      newIp();
      await awayFromHourEdge();
      for (let i = 0; i < 120; i++) await enforce(db, "browse", { ip: ipSubjectOf(state.ip) });
      for (const r of [
        await actions.loadDaySummary({ serviceId: A.servicePublic, staffId: "any" }),
        await actions.loadPublicSlots({ serviceId: A.servicePublic, staffId: "any", date: addDays(today, 3) }),
        await actions.loadRescheduleDays({ token: "x".repeat(43) }),
        await actions.loadRescheduleSlots({ token: "x".repeat(43), date: addDays(today, 3) }),
      ]) {
        expect(r.ok).toBe(false);
        expect((r as { error: string }).error).toMatch(/^Vas muy rápido/);
      }
      newIp();
      expect((await actions.loadDaySummary({ serviceId: A.servicePublic, staffId: "any" })).ok).toBe(true);
    },
  },
  {
    action: "startBooking",
    name: "si Turnstile falla no se escribe nada (ni cookie)",
    run: async () => {
      newIp();
      newBrowser();
      const before = await fingerprint();
      const r = await actions.startBooking(startInput(newPhone(), { turnstileToken: "malo" }));
      expect(r.ok).toBe(false);
      expect(await fingerprint()).toBe(before);
      expect(state.jar.size).toBe(0);
    },
  },
  {
    action: "startBooking",
    name: "teléfono existente y nuevo dan la misma respuesta; el nombre existente no cambia",
    run: async () => {
      newIp();
      const existing = newPhone();
      await findOrCreateClient(db, { locationId: A.location, name: "Pedro Original", phone: existing });
      newBrowser();
      const a = await actions.startBooking(startInput(existing, { name: "Otro Nombre" }));
      newBrowser();
      const b = await actions.startBooking(startInput(newPhone(), { name: "Otro Nombre" }));
      if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]));
      expect(Object.keys(a.data).sort()).toEqual(Object.keys(b.data).sort());
      expect(a.data.channel).toBe(b.data.channel);
      expect(a.data.maskedDestination).toMatch(/^\d{3} ••• ••\d{2}$/);
      expect(b.data.maskedDestination).toMatch(/^\d{3} ••• ••\d{2}$/);
      expect(notifier.lastCode(e164(existing))).toMatch(/^\d{6}$/);
      const [row] = await db.select({ name: clients.name }).from(clients).where(eq(clients.phoneE164, e164(existing)));
      expect(row!.name).toBe("Pedro Original");
      expect(state.cookieOptions).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/reservar" });
    },
  },
  {
    action: "startBooking",
    name: "superar el límite da 'Vas muy rápido' y dice cuánto esperar",
    run: async () => {
      newIp();
      await awayFromHourEdge();
      const phone = newPhone();
      const results = [];
      for (let i = 0; i < 6; i++) {
        newBrowser();
        results.push(await actions.startBooking(startInput(phone)));
      }
      expect(results.slice(0, 5).every((r) => r.ok)).toBe(true);
      expect(results[5]!.ok).toBe(false);
      // booking_start por celular: 5 por hora → espera lo que falte de la hora.
      expect((results[5] as { error: string }).error).toMatch(/^Vas muy rápido\. (Espera \d+ minutos y vuelve a intentar|Espera un minuto y vuelve a intentar)\.$/);
    },
  },
  {
    action: "startBooking",
    name: "solo celulares colombianos: un fijo o uno extranjero no escribe nada",
    run: async () => {
      newIp();
      newBrowser();
      const before = await fingerprint();
      for (const phone of ["+1 415 555 0100", "601 555 1234", "+44 7700 900123", "+57 601 555 1234"]) {
        expect(await actions.startBooking(startInput(phone))).toEqual({ ok: false, error: PUBLIC_MESSAGES.phone });
      }
      expect(await fingerprint()).toBe(before);
      expect(state.jar.size).toBe(0);
    },
  },
  {
    action: "startBooking",
    name: "el código va solo por WhatsApp y el correo escrito no toca al cliente hasta verificar (y nunca reemplaza uno)",
    run: async () => {
      newIp();
      // Laura ya tiene correo. Alguien con su celular escribe otro: no cambia ni al iniciar ni al verificar.
      const laura = newPhone();
      const c = await findOrCreateClient(db, { locationId: A.location, name: "Laura Real", phone: laura });
      await db.update(clients).set({ email: "laura@real.co" }).where(eq(clients.id, c.id));
      newBrowser();
      const started = await actions.startBooking(startInput(laura, { email: "otro@evil.co", name: "Otro Nombre" }));
      if (!started.ok) throw new Error(started.error);
      expect(started.data.channel).toBe("whatsapp");
      expect(await clientRow(laura)).toMatchObject({ email: "laura@real.co", name: "Laura Real" });
      expect((await actions.verifyCode({ code: notifier.lastCode(e164(laura))! })).ok).toBe(true);
      expect(await clientRow(laura)).toMatchObject({ email: "laura@real.co", name: "Laura Real" });

      // Sin correo: el escrito espera en la verificación y pasa al cliente solo con el código correcto.
      const fresh = newPhone();
      newBrowser();
      expect((await actions.startBooking(startInput(fresh, { email: "Nuevo@Correo.co" }))).ok).toBe(true);
      const pending = await clientRow(fresh);
      expect(pending.email).toBeNull();
      const [v] = await db.select({ email: bookingVerifications.contactEmail, channel: bookingVerifications.channel }).from(bookingVerifications).where(eq(bookingVerifications.clientId, pending.id));
      expect(v).toEqual({ email: "nuevo@correo.co", channel: "whatsapp" });
      expect((await actions.verifyCode({ code: notifier.lastCode(e164(fresh))! })).ok).toBe(true);
      expect((await clientRow(fresh)).email).toBe("nuevo@correo.co");
      expect(notifier.sent.filter((s) => s.template === "otp").every((s) => s.channel === "whatsapp")).toBe(true);
    },
  },
  {
    action: "startBooking",
    name: "IPv6: toda la /64 comparte la cubeta de la IP; otra /64 no",
    run: async () => {
      await awayFromHourEdge();
      // booking_start por IP: 10 por hora. Se llena la cubeta de la /64 y se prueba desde otra IP de la misma red.
      const subject = ipSubjectOf("2001:db8:77:1::1");
      for (let i = 0; i < 10; i++) await enforce(db, "booking_start", { ip: subject });
      state.ip = "2001:db8:77:1:abcd:ef01:2345:6789";
      newBrowser();
      const blocked = await actions.startBooking(startInput(newPhone()));
      expect(blocked.ok).toBe(false);
      expect((blocked as { error: string }).error).toMatch(/^Vas muy rápido/);
      state.ip = "2001:db8:77:2::1";
      newBrowser();
      expect((await actions.startBooking(startInput(newPhone()))).ok).toBe(true);
      newIp();
    },
  },
  {
    action: "startBooking",
    name: "tope de retenciones vivas por sede: la que sobra da 'horario tomado' y no cuenta envíos",
    run: async () => {
      newIp();
      const [{ live }] = (await db
        .select({ live: sql<number>`count(*)::int` })
        .from(appointments)
        .where(
          and(
            eq(appointments.locationId, A.location),
            eq(appointments.status, "pending"),
            eq(appointments.source, "online"),
            sql`${appointments.expiresAt} > now()`,
          ),
        )) as [{ live: number }];
      const fillers: bigint[] = [];
      for (let i = Number(live); i < MAX_PENDING_HOLDS; i++) {
        const c = await findOrCreateClient(db, { locationId: A.location, name: "Relleno", phone: newPhone() });
        const { date, minute } = nextSlot();
        const hold = await createAppointment(db, {
          locationId: A.location,
          serviceId: A.service,
          staffId: A.barber,
          start: localMinuteToInstant(date, minute, TZ),
          clientId: c.id,
          source: "online",
          idempotencyKey: `relleno-${randomUUID()}`,
          createdBy: "online",
        });
        fillers.push(hold.appointmentId);
      }
      const hits = await otpSendHits();
      const held = await heldAndSent();
      newBrowser();
      expect(await actions.startBooking(startInput(newPhone()))).toEqual({ ok: false, error: PUBLIC_MESSAGES.slotTaken });
      expect(await otpSendHits()).toBe(hits);
      expect(await heldAndSent()).toBe(held);

      // Al liberarse, se vuelve a poder (y ahí sí cuenta el envío).
      await db.update(appointments).set({ expiresAt: new Date(Date.now() - MINUTE_MS) }).where(inArray(appointments.id, fillers));
      newBrowser();
      expect((await actions.startBooking(startInput(newPhone()))).ok).toBe(true);
      expect(await otpSendHits()).toBeGreaterThan(hits);
    },
  },
  {
    action: "startBooking",
    name: "los códigos cuentan en la cuota global: avisan al 80 % y al tope no se retiene nada",
    run: async () => {
      newIp();
      const [{ sent }] = (await db
        .select({ sent: sql<number>`count(*)::int` })
        .from(notificationEvents)
        .where(and(eq(notificationEvents.locationId, A.location), eq(notificationEvents.kind, "sent")))) as [{ sent: number }];
      vi.stubEnv("NOTIFY_CAP_GLOBAL", String(Number(sent) + 1));
      try {
        state.alerts.length = 0;
        const phone = newPhone();
        newBrowser();
        expect((await actions.startBooking(startInput(phone))).ok).toBe(true);
        const c = await clientRow(phone);
        const [otp] = await db
          .select({ id: notifications.id, params: notifications.params, channel: notifications.channel })
          .from(notifications)
          .where(and(eq(notifications.clientId, c.id), eq(notifications.template, "otp")));
        expect(otp).toMatchObject({ params: { code: "[redacted]" }, channel: "whatsapp" });
        const events = await db.select({ kind: notificationEvents.kind }).from(notificationEvents).where(eq(notificationEvents.notificationId, otp!.id)).orderBy(notificationEvents.id);
        expect(events.map((e) => e.kind)).toEqual(["attempt", "sent"]);
        expect(state.alerts).toEqual([`Villa: van ${Number(sent) + 1} de ${Number(sent) + 1} mensajes hoy`]);

        newBrowser();
        const held = await heldAndSent();
        expect(await actions.startBooking(startInput(newPhone()))).toEqual({ ok: false, error: PUBLIC_MESSAGES.sendingPaused });
        expect(await heldAndSent()).toBe(held);
      } finally {
        vi.stubEnv("NOTIFY_CAP_GLOBAL", "");
      }
    },
  },
  {
    action: "startBooking",
    name: "sin autorizar el tratamiento de datos no se reserva",
    run: async () => {
      newIp();
      newBrowser();
      const r = await actions.startBooking(startInput(newPhone(), { consents: { dataProcessing: false, reminders: true, marketing: true } }));
      expect(r).toEqual({ ok: false, error: "Para reservar debes autorizar el tratamiento de tus datos" });
    },
  },
  {
    action: "verifyCode",
    name: "el código correcto confirma, guarda consentimientos, verifica al cliente y encola la confirmación",
    run: async () => {
      newIp();
      const phone = newPhone();
      const token = await bookAndVerify(phone);
      const appt = await appointmentByToken(token);
      expect(appt.status).toBe("confirmed");
      const [c] = await db.select({ id: clients.id, verifiedAt: clients.verifiedAt }).from(clients).where(eq(clients.phoneE164, e164(phone)));
      expect(c!.verifiedAt).not.toBeNull();
      const consents = await db.select({ purpose: clientConsents.purpose, granted: clientConsents.granted }).from(clientConsents).where(eq(clientConsents.clientId, c!.id));
      expect(consents).toEqual(
        expect.arrayContaining([
          { purpose: "data_processing", granted: true },
          { purpose: "reminders", granted: true },
          { purpose: "marketing", granted: false },
        ]),
      );
      expect(await db.$count(notifications, and(eq(notifications.appointmentId, appt.id), eq(notifications.template, "booking_confirmed")))).toBe(1);
      expect(state.jar.has("villa_hold")).toBe(false);
      const ticket = await data.loadTicket(token);
      expect(ticket).toMatchObject({ status: "confirmed", statusLabel: "Confirmada", serviceName: "Corte", staffName: "Andrés Gómez", clientFirstName: "Ana" });
      expect(ticket!.code).toMatch(/^V-[0-9A-Z]{4}$/);
      expect(ticket!.priceLabel).toContain("35.000");
    },
  },
  {
    action: "verifyCode",
    name: "el nombre escrito solo se guarda al verificar, y solo en un cliente nacido en línea que nunca se verificó",
    run: async () => {
      newIp();
      // Alguien usa el celular de Sofía con un nombre falso; Sofía reserva después y verifica: queda su nombre.
      const sofia = newPhone();
      newBrowser();
      expect((await actions.startBooking(startInput(sofia, { name: "Nombre Falso" }))).ok).toBe(true);
      newBrowser();
      expect((await actions.startBooking(startInput(sofia, { name: "Sofía Real" }))).ok).toBe(true);
      expect((await clientRow(sofia)).name).toBe("Nombre Falso");
      expect((await actions.verifyCode({ code: notifier.lastCode(e164(sofia))! })).ok).toBe(true);
      expect((await clientRow(sofia)).name).toBe("Sofía Real");

      // Ya verificada: otro nombre en una reserva nueva no la cambia.
      newBrowser();
      expect((await actions.startBooking(startInput(sofia, { name: "Otra Persona" }))).ok).toBe(true);
      expect((await actions.verifyCode({ code: notifier.lastCode(e164(sofia))! })).ok).toBe(true);
      expect((await clientRow(sofia)).name).toBe("Sofía Real");

      // Creado en el panel (nunca verificado): verificar no le cambia el nombre.
      const fromPanel = newPhone();
      await findOrCreateClient(db, { locationId: A.location, name: "Cliente Del Panel", phone: fromPanel });
      newBrowser();
      expect((await actions.startBooking(startInput(fromPanel, { name: "Cambio De Nombre" }))).ok).toBe(true);
      expect((await actions.verifyCode({ code: notifier.lastCode(e164(fromPanel))! })).ok).toBe(true);
      expect((await clientRow(fromPanel)).name).toBe("Cliente Del Panel");
    },
  },
  {
    action: "verifyCode",
    name: "la cookie de otro navegador no verifica",
    run: async () => {
      newIp();
      const phone = newPhone();
      newBrowser();
      expect((await actions.startBooking(startInput(phone))).ok).toBe(true);
      const mine = state.jar;
      const code = notifier.lastCode(e164(phone))!;
      newBrowser();
      expect(await actions.verifyCode({ code })).toEqual({ ok: false, error: PUBLIC_MESSAGES.holdExpired });
      state.jar = new Map([["villa_hold", "x".repeat(43)]]);
      expect(await actions.verifyCode({ code })).toEqual({ ok: false, error: PUBLIC_MESSAGES.holdExpired });
      state.jar = mine;
      expect((await actions.verifyCode({ code })).ok).toBe(true);
    },
  },
  {
    action: "verifyCode",
    name: "el código se consume una sola vez aunque lleguen dos a la vez",
    run: async () => {
      newIp();
      const phone = newPhone();
      newBrowser();
      await actions.startBooking(startInput(phone));
      const code = notifier.lastCode(e164(phone))!;
      const results = await Promise.all([actions.verifyCode({ code }), actions.verifyCode({ code })]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await db.$count(bookingVerifications, sql`${bookingVerifications.consumedAt} is not null and ${bookingVerifications.clientId} = (select id from clients where phone_e164 = ${e164(phone)})`)).toBe(1);
    },
  },
  {
    action: "verifyCode",
    name: "cinco códigos errados bloquean, aunque después llegue el correcto",
    run: async () => {
      newIp();
      const phone = newPhone();
      newBrowser();
      await actions.startBooking(startInput(phone));
      const code = notifier.lastCode(e164(phone))!;
      const wrong = code === "000000" ? "111111" : "000000";
      const errors: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await actions.verifyCode({ code: wrong });
        if (!r.ok) errors.push(r.error);
      }
      expect(errors[0]).toBe("Ese código no coincide. Te quedan 4 intentos.");
      expect(errors[3]).toBe("Ese código no coincide. Te queda 1 intento.");
      expect(errors.every((e) => e.startsWith("Ese código no coincide."))).toBe(true);
      expect(await actions.verifyCode({ code })).toEqual({ ok: false, error: PUBLIC_MESSAGES.tooManyAttempts });
    },
  },
  {
    action: "verifyCode",
    name: "si la retención venció, el mensaje es el de tiempo agotado",
    run: async () => {
      newIp();
      const phone = newPhone();
      newBrowser();
      await actions.startBooking(startInput(phone));
      const [c] = await db.select({ id: clients.id }).from(clients).where(eq(clients.phoneE164, e164(phone)));
      await db.update(appointments).set({ expiresAt: new Date(Date.now() - MINUTE_MS) }).where(and(eq(appointments.clientId, c!.id), eq(appointments.status, "pending")));
      const r = await actions.verifyCode({ code: notifier.lastCode(e164(phone))! });
      expect(r).toEqual({ ok: false, error: PUBLIC_MESSAGES.holdExpired });
      expect(PUBLIC_MESSAGES.holdExpired.startsWith("Se acabó el tiempo")).toBe(true);
    },
  },
  {
    action: "verifyCode",
    name: "con el tope de citas activas, la cuarta se libera con un mensaje claro",
    run: async () => {
      newIp();
      const phone = newPhone();
      for (let i = 0; i < 3; i++) await bookAndVerify(phone);
      newBrowser();
      await actions.startBooking(startInput(phone));
      const r = await actions.verifyCode({ code: notifier.lastCode(e164(phone))! });
      expect(r).toEqual({ ok: false, error: "Ya tienes 3 citas activas con este número. Revísalas desde el enlace que te enviamos por WhatsApp." });
      const [c] = await db.select({ id: clients.id }).from(clients).where(eq(clients.phoneE164, e164(phone)));
      expect(await db.$count(appointments, and(eq(appointments.clientId, c!.id), eq(appointments.status, "pending")))).toBe(0);
    },
  },
  {
    action: "resendCode",
    name: "espera 60 s, reemplaza el código anterior y descuenta envíos",
    run: async () => {
      newIp();
      const phone = newPhone();
      newBrowser();
      await actions.startBooking(startInput(phone));
      const first = notifier.lastCode(e164(phone))!;
      const early = await actions.resendCode();
      expect(early.ok).toBe(false);
      expect((early as { error: string }).error).toMatch(/^Espera \d+ segundos/);

      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
      try {
        const r = await actions.resendCode();
        if (!r.ok) throw new Error(r.error);
        expect(r.data.sendsLeft).toBe(1);
        const second = notifier.lastCode(e164(phone))!;
        if (second !== first) {
          const old = await actions.verifyCode({ code: first });
          expect(old.ok).toBe(false);
        }
        expect((await actions.verifyCode({ code: second })).ok).toBe(true);
      } finally {
        vi.useRealTimers();
      }
      newBrowser();
      expect(await actions.resendCode()).toEqual({ ok: false, error: PUBLIC_MESSAGES.holdExpired });
    },
  },
  {
    action: "cancelByToken",
    name: "cancelar dos veces no hace nada la segunda; el enlace queda revocado",
    run: async () => {
      newIp();
      const token = await bookAndVerify();
      expect(await actions.cancelByToken({ token, reason: "Me salió algo" })).toEqual({ ok: true, data: undefined });
      expect(await actions.cancelByToken({ token })).toEqual({ ok: true, data: undefined });
      const appt = await appointmentByToken(token);
      expect(appt.status).toBe("cancelled");
      expect(appt.revokedAt).not.toBeNull();
      expect(await db.$count(notifications, and(eq(notifications.appointmentId, appt.id), eq(notifications.template, "appointment_cancelled_client")))).toBe(1);
      expect(await data.loadTicket(token)).toBeNull();
    },
  },
  {
    action: "cancelByToken",
    name: "cancelar después de la hora de inicio se rechaza",
    run: async () => {
      newIp();
      const c = await findOrCreateClient(db, { locationId: A.location, name: "Tarde", phone: newPhone() });
      const start = new Date(Math.floor((Date.now() - 10 * MINUTE_MS) / (5 * MINUTE_MS)) * 5 * MINUTE_MS);
      const appt = await createAppointment(db, {
        locationId: A.location,
        serviceId: A.service,
        staffId: A.barber,
        start,
        clientId: c.id,
        source: "staff",
        idempotencyKey: `past-${randomUUID()}`,
        createdBy: "seed",
      });
      const token = await issueManageLink(db, { locationId: A.location, appointmentId: appt.appointmentId, publicId: appt.publicId, appointmentEnd: new Date(start.getTime() + 40 * MINUTE_MS), secret: DEV_ONLY_MANAGE_LINK_SECRET });
      const r = await actions.cancelByToken({ token });
      expect(r).toEqual({ ok: false, error: "Tu cita ya empezó; ya no se puede cambiar desde aquí. Escríbenos por WhatsApp." });
    },
  },
  {
    action: "loadRescheduleDays",
    name: "días para reprogramar con el mismo barbero",
    run: async () => {
      newIp();
      const token = await bookAndVerify();
      const r = await actions.loadRescheduleDays({ token });
      if (!r.ok) throw new Error(r.error);
      expect(r.data.days).toHaveLength(14);
      expect(await actions.loadRescheduleDays({ token: "x".repeat(43) })).toEqual({ ok: false, error: PUBLIC_MESSAGES.linkInvalid });
    },
  },
  {
    action: "loadRescheduleSlots",
    name: "horarios para reprogramar: la propia cita no cuenta como ocupada",
    run: async () => {
      newIp();
      const token = await bookAndVerify();
      const appt = await appointmentByToken(token);
      const own = localParts(appt.during.start, TZ);
      const r = await actions.loadRescheduleSlots({ token, date: own.date });
      if (!r.ok) throw new Error(r.error);
      expect(r.data.slots.some((s) => s.minute === own.minute)).toBe(true);
      expect(await actions.loadRescheduleSlots({ token, date: addDays(today, 30) })).toEqual({ ok: false, error: PUBLIC_MESSAGES.dateOutOfRange });
    },
  },
  {
    action: "rescheduleByToken",
    name: "dos reprogramaciones a la vez no pasan el tope de 2 (se revisa con la cita bloqueada)",
    run: async () => {
      newIp();
      const token = await bookAndVerify();
      expect((await actions.rescheduleByToken({ token, ...nextSlot() })).ok).toBe(true);
      const results = await Promise.all([actions.rescheduleByToken({ token, ...nextSlot() }), actions.rescheduleByToken({ token, ...nextSlot() })]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "Ya reprogramaste esta cita 2 veces. Para otro cambio, escríbenos por WhatsApp." });
      expect(await actions.rescheduleByToken({ token, ...nextSlot() })).toMatchObject({ ok: false });
    },
  },
  {
    action: "rescheduleByToken",
    name: "reprograma a un horario ofrecido y rechaza uno dentro de la anticipación mínima",
    run: async () => {
      newIp();
      const token = await bookAndVerify();
      const target = nextSlot();
      const r = await actions.rescheduleByToken({ token, ...target });
      if (!r.ok) throw new Error(r.error);
      expect(r.data.timeLabel).toMatch(/^\d{1,2}:\d{2} [ap]\. m\.$/);
      const appt = await appointmentByToken(token);
      expect(localParts(appt.during.start, TZ)).toEqual(target);
      expect(await db.$count(notifications, and(eq(notifications.appointmentId, appt.id), eq(notifications.template, "appointment_rescheduled")))).toBe(1);

      const soon = localParts(new Date(Math.ceil((Date.now() + 30 * MINUTE_MS) / (15 * MINUTE_MS)) * 15 * MINUTE_MS), TZ);
      expect(await actions.rescheduleByToken({ token, ...soon })).toEqual({ ok: false, error: PUBLIC_MESSAGES.tooSoon });
    },
  },
];

describe("acciones públicas", () => {
  it.each(CASES)("$action · $name", async ({ run }) => {
    await run();
  });
});

describe("lecturas y enlaces malos", () => {
  it("la portada trae servicios, barberos en línea y horario con textos listos", async () => {
    const portal = await data.loadPortal();
    expect(portal).toMatchObject({ enabled: true, today, maxAdvanceDays: 14, turnstileSiteKey: null });
    expect(portal!.services).toEqual([{ id: A.servicePublic, name: "Corte", durationMin: 30, priceLabel: expect.stringContaining("35.000") }]);
    expect(portal!.staff).toEqual([{ id: A.barberPublic, name: "Andrés Gómez", initials: "AG" }]);
    expect(portal!.hours[0]).toEqual({ weekday: 1, label: "Lunes", ranges: ["12:00 a. m. – 12:00 a. m."] });
    expect(portal!.location.whatsappUrl).toBe("https://wa.me/573005551234");
  });

  it("todo token malo da el mismo null y el mismo 404", async () => {
    newIp();
    // Revocado (cancelado), vencido, de otra sede, desconocido con forma válida y basura.
    const cancelled = await bookAndVerify();
    await actions.cancelByToken({ token: cancelled });
    const expired = await bookAndVerify();
    await db.update(appointmentLinks).set({ expiresAt: new Date(Date.now() - 86_400_000) }).where(eq(appointmentLinks.appointmentId, (await appointmentByToken(expired)).id));
    const c = await findOrCreateClient(db, { locationId: B.location, name: "Cliente B", phone: newPhone() });
    const apptB = await createAppointment(db, {
      locationId: B.location,
      serviceId: B.service,
      staffId: B.barber,
      start: new Date(Date.now() + 3 * 86_400_000),
      clientId: c.id,
      source: "staff",
      idempotencyKey: `b-${randomUUID()}`,
      createdBy: "seed",
    });
    const otherLocation = await issueManageLink(db, { locationId: B.location, appointmentId: apptB.appointmentId, publicId: apptB.publicId, appointmentEnd: apptB.start, secret: DEV_ONLY_MANAGE_LINK_SECRET });

    const bad = [cancelled, expired, otherLocation, "A".repeat(43), "basura", "../../etc"];
    const bodies = new Set<string>();
    for (const token of bad) {
      expect(await data.loadTicket(token)).toBeNull();
      const res = await ics.GET(new Request("http://localhost/x"), { params: Promise.resolve({ token }) });
      expect(res.status).toBe(404);
      bodies.add(await res.text());
      expect(await actions.rescheduleByToken({ token, ...nextSlot() })).toEqual({ ok: false, error: PUBLIC_MESSAGES.linkInvalid });
    }
    expect(bodies.size).toBe(1);
    // Cancelar con un enlace de otra sede tampoco hace nada.
    expect(await actions.cancelByToken({ token: otherLocation })).toEqual({ ok: false, error: PUBLIC_MESSAGES.linkInvalid });
    expect((await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, apptB.appointmentId)))[0]!.status).toBe("confirmed");
  });

  it("el .ics de un enlace válido va en UTC, sin caché y con el enlace de gestión", async () => {
    newIp();
    const token = await bookAndVerify();
    const res = await ics.GET(new Request("http://localhost/x"), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(body).toContain("TRIGGER:-PT1H");
    expect(body.replace(/\r\n /g, "")).toContain(`/cita/${token}`);
  });
});

// ─── Completitud ─────────────────────────────────────────────────────────────

describe("guarda de completitud", () => {
  it("toda server action exportada de (publico)/actions.ts tiene al menos un caso", () => {
    // Cada export de un archivo "use server" es un endpoint público: si alguien agrega uno y no
    // lo prueba aquí, este test falla.
    const exported = Object.entries(actions)
      .filter(([, v]) => typeof v === "function")
      .map(([name]) => name);
    const covered = new Set(CASES.map((c) => c.action));
    expect(exported.filter((name) => !covered.has(name))).toEqual([]);
  });
});
