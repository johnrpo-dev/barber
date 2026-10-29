import { dayAgenda, locationRules } from "@/db/appointments";
import { listServices } from "@/db/catalog";
import { db } from "@/db/client";
import type { Db } from "@/db/types";
import { addDays, isDateString, localMinuteToInstant, MINUTE_MS } from "@/domain/booking/clock";
import { type AppointmentStatus, availableTransitions } from "@/domain/booking/status";
import { formatPhone, maskPhone } from "@/domain/clients/client";
import { businessDate } from "@/domain/ledger/business-date";
import { format } from "@/domain/money";
import { can } from "@/domain/staff/roles";
import { formatTime } from "@/domain/staff/schedule";
import type { StaffContext } from "@/lib/session";

// Lo que la agenda necesita en el navegador, ya serializado: ids como texto, dinero ya
// formateado (el cliente no calcula plata) y horas como minutos locales del día.

export interface AgendaAppointmentView {
  id: string;
  publicId: string;
  staffId: string;
  staffName: string;
  serviceId: string;
  serviceName: string;
  clientName: string | null;
  /** Completo si el rol puede ver contactos; si no, enmascarado. */
  clientPhone: string | null;
  clientPhoneHref: string | null;
  startMin: number;
  serviceEndMin: number;
  endMin: number;
  timeLabel: string;
  status: AppointmentStatus;
  source: "staff" | "walk_in" | "online";
  notes: string | null;
  price: string;
  /** Cambios de estado que este usuario puede ofrecer ahora (el servidor vuelve a validar). */
  transitions: AppointmentStatus[];
  canReschedule: boolean;
}

export interface AgendaColumnView {
  staffId: string;
  displayName: string;
  blocks: { startMin: number; endMin: number }[];
}

export interface AgendaTimeOffView {
  id: string;
  staffId: string | null;
  startMin: number;
  endMin: number;
  kind: "absence" | "block";
  reason: string | null;
}

export interface ServiceOption {
  id: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  price: string;
}

export interface AgendaView {
  date: string;
  today: string;
  timeZone: string;
  /** Inicio del día local en ms UTC: con esto el cliente ubica la línea de "ahora". */
  dayStartMs: number;
  nowMs: number;
  columns: AgendaColumnView[];
  appointments: AgendaAppointmentView[];
  timeOff: AgendaTimeOffView[];
  services: ServiceOption[];
  viewer: { staffId: string; canManageAll: boolean };
}

/** `?fecha=` válida o el día de hoy en la sede. */
export function resolveDate(raw: string | string[] | undefined, timeZone: string, now: Date): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && isDateString(value) ? value : businessDate(now, timeZone);
}

export async function loadAgenda(
  staff: StaffContext,
  rawDate: string | string[] | undefined,
  /** Mi día: solo las citas de quien mira, aunque pueda ver toda la sede. */
  options: { ownOnly?: boolean } = {},
): Promise<AgendaView> {
  const database = db() as unknown as Db;
  const now = new Date();
  const rules = await locationRules(database, staff.locationId);
  const date = resolveDate(rawDate, rules.timeZone, now);
  const manageAll = can(staff.role, "appointments.manage.all");
  const seeContact = can(staff.role, "clients.view.contact");

  const [agenda, services] = await Promise.all([
    dayAgenda(database, { locationId: staff.locationId, date, staffId: manageAll && !options.ownOnly ? undefined : staff.staffId }),
    listServices(database, { locationId: staff.locationId }),
  ]);

  const dayStart = localMinuteToInstant(date, 0, rules.timeZone).getTime();
  const dayEnd = localMinuteToInstant(addDays(date, 1), 0, rules.timeZone).getTime();
  const toMin = (d: Date) => Math.round((Math.min(Math.max(d.getTime(), dayStart), dayEnd) - dayStart) / MINUTE_MS);

  return {
    date,
    today: businessDate(now, rules.timeZone),
    timeZone: rules.timeZone,
    dayStartMs: dayStart,
    nowMs: now.getTime(),
    columns: agenda.columns.map((c) => ({
      staffId: String(c.staffId),
      displayName: c.displayName,
      blocks: c.blocks.map((b) => ({ startMin: b.startMin, endMin: b.endMin })),
    })),
    appointments: agenda.appointments.map((a) => {
      const own = a.staffId === staff.staffId;
      const graceOver = now.getTime() >= a.start.getTime() + rules.noShowGraceMin * MINUTE_MS;
      const transitions = availableTransitions(a.status, { kind: "staff", role: staff.role, ownAppointment: own }).filter(
        (t) => t !== "no_show" || graceOver,
      );
      const startMin = toMin(a.start);
      const serviceEndMin = toMin(a.serviceEnd);
      return {
        id: String(a.id),
        publicId: a.publicId,
        staffId: String(a.staffId),
        staffName: a.staffName,
        serviceId: String(a.serviceId),
        serviceName: a.serviceName,
        clientName: a.clientName,
        clientPhone: a.clientPhone ? (seeContact ? formatPhone(a.clientPhone) : maskPhone(a.clientPhone)) : null,
        clientPhoneHref: a.clientPhone && seeContact ? `tel:${a.clientPhone}` : null,
        startMin,
        serviceEndMin,
        endMin: toMin(a.end),
        timeLabel: `${formatTime(startMin)} – ${formatTime(serviceEndMin)}`,
        status: a.status,
        source: a.source,
        notes: a.notes,
        price: format(a.price),
        transitions,
        canReschedule: manageAll && (a.status === "pending" || a.status === "confirmed" || a.status === "arrived"),
      };
    }),
    timeOff: agenda.timeOff
      .filter((t) => (manageAll && !options.ownOnly) || t.staffId === null || t.staffId === staff.staffId)
      .map((t) => ({
        id: String(t.id),
        staffId: t.staffId === null ? null : String(t.staffId),
        startMin: toMin(t.start),
        endMin: toMin(t.end),
        kind: t.kind,
        reason: t.reason,
      })),
    services: services.map((s) => ({
      id: String(s.id),
      name: s.name,
      durationMin: s.durationMin,
      bufferMin: s.bufferMin,
      price: format(s.price),
    })),
    viewer: { staffId: String(staff.staffId), canManageAll: manageAll },
  };
}
