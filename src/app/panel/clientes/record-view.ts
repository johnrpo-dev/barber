import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import type { ClientRecord } from "@/db/client-record";
import { type AppointmentStatus, STATUS_LABELS } from "@/domain/booking/status";
import { formatPhone, maskPhone } from "@/domain/clients/client";
import { CONSENT_PURPOSE_LABELS, CONSENT_PURPOSES, type ConsentPurpose, WITHDRAWABLE_PURPOSES } from "@/domain/clients/consent";
import { noShowNotice } from "@/domain/clients/no-shows";

// La ficha del cliente lista para mostrar: fechas y horas en la zona de la sede (con @date-fns/tz),
// así la pantalla recibe texto y no depende de la zona del navegador. Sin "use server": no es una acción.

export interface ConsentView {
  purpose: ConsentPurpose;
  label: string;
  granted: boolean;
  /** Versión de la política con la que se dio (o retiró); null si nunca hubo fila. */
  version: string | null;
  dateLabel: string | null;
  bySource: string | null;
  withdrawable: boolean;
}

export interface ClientRecordView {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  verified: boolean;
  sinceLabel: string;
  counts: { total: number; completed: number; noShows: number; cancelled: number; upcoming: number };
  history: { id: string; dateLabel: string; timeLabel: string; serviceName: string; staffName: string; status: AppointmentStatus; statusLabel: string }[];
  historyLimit: number;
  noShows: { count: number; limit: number; suspended: boolean; notice: string | null };
  consents: ConsentView[];
  devices: { active: number; lastUsedLabel: string | null };
}

const dayLabel = (d: Date, tz: string) => format(new TZDate(d.getTime(), tz), "d MMM yyyy", { locale: es }).replace(/\./g, "");
const timeLabel = (d: Date, tz: string) => format(new TZDate(d.getTime(), tz), "HH:mm");

export function toClientRecordView(
  r: ClientRecord,
  opts: { timeZone: string; historyLimit: number; canViewContact: boolean },
): ClientRecordView {
  const tz = opts.timeZone;
  return {
    id: r.id.toString(),
    name: r.name,
    phone: r.phoneE164 ? (opts.canViewContact ? formatPhone(r.phoneE164) : maskPhone(r.phoneE164)) : null,
    email: opts.canViewContact ? r.email : null,
    verified: r.verified,
    sinceLabel: dayLabel(r.createdAt, tz),
    counts: r.counts,
    history: r.history.map((h) => ({
      id: h.id.toString(),
      dateLabel: dayLabel(h.start, tz),
      timeLabel: timeLabel(h.start, tz),
      serviceName: h.serviceName,
      staffName: h.staffName,
      status: h.status,
      statusLabel: STATUS_LABELS[h.status],
    })),
    historyLimit: opts.historyLimit,
    noShows: { ...r.noShows, notice: noShowNotice(r.noShows) },
    consents: CONSENT_PURPOSES.map((purpose) => {
      const row = r.consents[purpose];
      return {
        purpose,
        label: CONSENT_PURPOSE_LABELS[purpose],
        granted: row?.granted ?? false,
        version: row?.textVersion ?? null,
        dateLabel: row ? `${dayLabel(row.createdAt, tz)}, ${timeLabel(row.createdAt, tz)}` : null,
        bySource: row ? (row.source === "staff" ? "En la barbería" : "En línea") : null,
        withdrawable: (WITHDRAWABLE_PURPOSES as readonly string[]).includes(purpose) && (row?.granted ?? false),
      };
    }),
    devices: { active: r.devices.active, lastUsedLabel: r.devices.lastUsedAt ? dayLabel(r.devices.lastUsedAt, tz) : null },
  };
}
