import { cookies } from "next/headers";
import { db } from "@/db/client";
import { DEVICE_COOKIE, knownClient } from "@/db/client-devices";
import { maskPhone } from "@/domain/clients/client";
import { firstNameForMessage } from "@/domain/notifications/templates";
import { loadPortalData, loadTicketData, publicLocation } from "@/db/public-booking";
import type { Db } from "@/db/types";
import type { AppointmentStatus } from "@/domain/booking/status";
import { publicBookingReadiness, publicConfig } from "@/lib/public-readiness";

// Lecturas del portal público para los Server Components (contrato de sprint-3-reserva-publica.md
// §10). Todo llega ya formateado: dinero, fechas y horas en la zona de la sede.

const database = () => db() as unknown as Db;

export interface PortalView {
  enabled: boolean; // reserva pública activa y configuración lista (publicBookingReadiness)
  location: { name: string; address: string | null; mapsUrl: string | null; publicPhone: string | null; whatsappUrl: string | null };
  services: { id: string /* uuid */; name: string; durationMin: number; priceLabel: string /* "$35.000" */ }[];
  staff: { id: string /* uuid */; name: string; initials: string }[];
  hours: { weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; label: string /* "Lunes" */; ranges: string[] /* ["9:00 a. m. – 7:00 p. m."] */ }[];
  openNow: { open: boolean; label: string /* "Abierto ahora · cierra a las 9:00 p. m." */ };
  featured: string[]; // ids de services, lo más pedido primero (máx. 6)
  featuredByDemand: boolean; // false: aún sin citas, es el orden del catálogo
  today: string; // yyyy-MM-dd en la zona de la sede
  maxAdvanceDays: number;
  holdMin: number;
  turnstileSiteKey: string | null; // null en desarrollo (verificador falso)
}

/** null: no hay sede pública (ninguna con public_booking_enabled). */
export async function loadPortal(): Promise<PortalView | null> {
  const location = await publicLocation(database());
  if (!location) return null;
  const readiness = publicBookingReadiness();
  const data = await loadPortalData(database(), location, new Date(), { cacheDemand: true });
  let turnstileSiteKey: string | null = null;
  if (readiness.ready) turnstileSiteKey = publicConfig().turnstile?.siteKey ?? null;
  return { enabled: location.publicBookingEnabled && readiness.ready, ...data, turnstileSiteKey };
}

export interface KnownClientView {
  firstName: string;
  maskedPhone: string; // "312 •••• 994"
}

/** El cliente recordado en este navegador (cookie villa_device), o null. Nunca el celular completo. */
export async function loadKnownClient(): Promise<KnownClientView | null> {
  const location = await publicLocation(database());
  if (!location) return null;
  const token = (await cookies()).get(DEVICE_COOKIE)?.value;
  const client = await knownClient(database(), { locationId: location.id, token, now: new Date() });
  return client ? { firstName: firstNameForMessage(client.name), maskedPhone: maskPhone(client.phoneE164) } : null;
}

export interface TicketView {
  code: string; // "V-4K7Q": últimos 4 del ULID
  status: AppointmentStatus;
  statusLabel: string;
  serviceName: string;
  staffName: string;
  clientFirstName: string;
  dateLabel: string; // "jueves 30 de octubre"
  timeLabel: string; // "3:30 p. m."
  durationMin: number;
  priceLabel: string;
  address: string | null;
  mapsUrl: string | null;
  startIso: string;
  endIso: string;
  serviceId: string;
  staffId: string; // uuid, para reprogramar
  cancel: { allowed: boolean; late: boolean; freeCancelHours: number };
  reschedule: { allowed: boolean; reason: string | null }; // reason en español si no se puede
  icsUrl: string; // /cita/[token]/calendario.ics
}

/** El ticket con el ULID de la cita (para el .ics). null = el mismo 404 para todo. */
export async function loadTicketWithId(token: string): Promise<(TicketView & { publicId: string }) | null> {
  if (typeof token !== "string" || token.length > 100) return null;
  // Si el dueño apaga la reserva, los enlaces de citas ya hechas siguen sirviendo.
  const location = await publicLocation(database(), { fallbackToFirst: true });
  if (!location) return null;
  return loadTicketData(database(), { location, token, now: new Date() });
}

/** null = el mismo 404 para todo (desconocido, vencido, revocado o de otra sede). */
export async function loadTicket(token: string): Promise<TicketView | null> {
  const ticket = await loadTicketWithId(token);
  if (!ticket) return null;
  const { publicId: _publicId, ...view } = ticket;
  return view;
}
