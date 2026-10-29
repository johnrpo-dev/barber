import { TZDate } from "@date-fns/tz";
import { isoWeekday } from "./clock";
import type { AppointmentStatus } from "./status";

// Textos para el cliente (portal y mensajes), en español de Colombia y en la zona de la sede.
// El panel usa formatTime ("15:30"); el cliente ve "3:30 p. m.".

const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const;
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;

/** 930 → "3:30 p. m."; 540 → "9:00 a. m."; 720 → "12:00 p. m."; 0 y 1440 → "12:00 a. m.". */
export function formatClock(minuteOfDay: number): string {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "a. m." : "p. m."}`;
}

/** "2026-10-30" → "viernes 30 de octubre". */
export function formatDateLabel(date: string): string {
  const [, mo, d] = date.split("-").map(Number) as [number, number, number];
  return `${WEEKDAYS[isoWeekday(date) - 1]} ${d} de ${MONTHS[mo - 1]}`;
}

/** Fecha local "yyyy-MM-dd" y minuto del día de un instante, en la zona de la sede. */
export function localParts(instant: Date, timeZone: string): { date: string; minute: number } {
  const z = new TZDate(instant.getTime(), timeZone);
  const date = `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, "0")}-${String(z.getDate()).padStart(2, "0")}`;
  return { date, minute: z.getHours() * 60 + z.getMinutes() };
}

export function instantLabels(instant: Date, timeZone: string): { dateLabel: string; timeLabel: string } {
  const { date, minute } = localParts(instant, timeZone);
  return { dateLabel: formatDateLabel(date), timeLabel: formatClock(minute) };
}

/** Código de turno que ve el cliente: "V-" + los últimos 4 caracteres del ULID. */
export function ticketCode(publicId: string): string {
  return `V-${publicId.slice(-4)}`;
}

/** Mañana (antes de 12:00), tarde (antes de 18:00) o noche: los mismos grupos del panel. */
export function dayPeriod(minuteOfDay: number): "morning" | "afternoon" | "evening" {
  if (minuteOfDay < 12 * 60) return "morning";
  if (minuteOfDay < 18 * 60) return "afternoon";
  return "evening";
}

/** Lo que ve el cliente en su ticket (el panel usa STATUS_LABELS). */
export const PUBLIC_STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending: "Por confirmar",
  confirmed: "Confirmada",
  arrived: "En la barbería",
  in_chair: "En la silla",
  completed: "Atendida",
  cancelled: "Cancelada",
  no_show: "No asististe",
};

/** "Andrés Felipe Gómez" → "AF"; "Ana" → "A". */
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => Array.from(w)[0]?.toUpperCase() ?? "")
    .join("");
}
