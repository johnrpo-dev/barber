import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

/**
 * Día contable: la fecha local de la sede, no la fecha UTC.
 * Un cobro a las 10 p. m. en Bogotá (03:00 UTC del día siguiente) pertenece al día de Bogotá.
 */
export function businessDate(instant: Date, timeZone: string): string {
  return format(new TZDate(instant, timeZone), "yyyy-MM-dd");
}
