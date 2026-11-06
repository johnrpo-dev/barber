import { deliverSecurityAlerts } from "@/db/security-alerts";
import type { Db } from "@/db/types";
import { alertSender } from "@/lib/notify";

type Send = (subject: string, text: string, idempotencyKey: string) => Promise<void>;

/**
 * Cada minuto: entrega los avisos de seguridad pendientes (bloqueos por intentos fallidos) al
 * dueño. Con correo configurado (RESEND_API_KEY, EMAIL_FROM y ALERT_EMAIL; no depende de WhatsApp
 * ni de Turnstile) van a ALERT_EMAIL; sin correo quedan en el registro del servidor, solo con el
 * asunto (sin nombres).
 */
export async function runSecurityAlerts(db: Db, now: Date = new Date(), deps: { send?: Send } = {}): Promise<{ delivered: number }> {
  return { delivered: await deliverSecurityAlerts(db, deps.send ?? alertSender(), { now }) };
}
