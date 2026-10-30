import { localMinuteOf } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { format, money } from "@/domain/money";
import { formatTime } from "@/domain/staff/schedule";

// Lo que sale hacia la interfaz (docs/sprint-4-cobro-caja.md §9): dinero como texto de centavos
// (`…Minor`) más su etiqueta ya formateada (`…Label`); horas en la zona de la sede.

export const minorText = (minor: bigint): string => minor.toString();
export const moneyLabel = (minor: bigint): string => format(money(minor));
/** Valor absoluto formateado (el signo va aparte, en `sign`). */
export const absLabel = (minor: bigint): string => moneyLabel(minor < 0n ? -minor : minor);
/** Con signo explícito: "+$ 2.000", "-$ 500", "$ 0". */
export const signedLabel = (minor: bigint): string => (minor > 0n ? `+${moneyLabel(minor)}` : moneyLabel(minor));

/** "14:30" en la zona de la sede. */
export const timeLabel = (at: Date, timeZone: string): string => formatTime(localMinuteOf(at, timeZone));

/** "14:30" si es el día dado; si no, "2026-10-28 14:30". */
export function atLabel(at: Date, timeZone: string, today?: string): string {
  const day = businessDate(at, timeZone);
  return day === today ? timeLabel(at, timeZone) : `${day} ${timeLabel(at, timeZone)}`;
}
