// Cuotas de envío por día contable: protegen la cuenta de WhatsApp/correo y la factura.
// Al 80 % se avisa al dueño (ALERT_EMAIL); al 100 % los envíos quedan `suppressed`.

export const DEFAULT_CAPS = { perRecipientPerDay: 6, globalPerDay: 300 } as const;

export type QuotaState = "ok" | "warn" | "blocked";

/** `sentToday` son los ya enviados hoy: con `cap` enviados, el siguiente se bloquea. */
export function quotaState(sentToday: number, cap: number): QuotaState {
  if (sentToday >= cap) return "blocked";
  // ≥ 80 % en enteros, sin flotantes.
  if (sentToday * 10 >= cap * 8) return "warn";
  return "ok";
}
