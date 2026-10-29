import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import type { TimeRange } from "@/db/tstzrange";

// Ausencias listas para mostrar: las fechas se formatean en el servidor con la zona de la sede,
// así el cliente recibe texto y no depende de la zona del navegador.

export interface TimeOffView {
  id: string;
  kind: "absence" | "block";
  allDay: boolean;
  /** "lunes 3 de noviembre" o "3 nov – 5 nov 2026". */
  dateLabel: string;
  /** "14:00–16:00" o "Todo el día". */
  timeLabel: string;
  reason: string | null;
}

const DAY_MS = 86_400_000;

export function toTimeOffView(
  row: { id: bigint; kind: string; allDay: boolean; during: TimeRange; reason: string | null },
  timeZone: string,
): TimeOffView {
  const start = new TZDate(row.during.start.getTime(), timeZone);
  // El rango es semiabierto: el último día incluido es el anterior al fin.
  const lastDay = new TZDate(row.during.end.getTime() - (row.allDay ? DAY_MS / 2 : 0), timeZone);
  const sameDay = format(start, "yyyy-MM-dd") === format(lastDay, "yyyy-MM-dd");
  const end = new TZDate(row.during.end.getTime(), timeZone);

  return {
    id: row.id.toString(),
    kind: row.kind === "block" ? "block" : "absence",
    allDay: row.allDay,
    dateLabel: sameDay
      ? format(start, "EEEE d 'de' MMMM", { locale: es })
      : `${format(start, "d MMM", { locale: es })} – ${format(lastDay, "d MMM yyyy", { locale: es })}`,
    timeLabel: row.allDay
      ? sameDay
        ? "Todo el día"
        : "Días completos"
      : `${format(start, "HH:mm")}–${format(end, "HH:mm")}`,
    reason: row.reason,
  };
}
