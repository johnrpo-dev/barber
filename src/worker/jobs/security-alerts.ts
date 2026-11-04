import { deliverSecurityAlerts } from "@/db/security-alerts";
import type { Db } from "@/db/types";
import { alertSender } from "@/lib/notify";

type Send = (subject: string, text: string, idempotencyKey: string) => Promise<void>;

/**
 * Cada minuto: entrega los avisos de seguridad pendientes (bloqueos por intentos fallidos) al
 * dueño. Con correo configurado van a ALERT_EMAIL; sin configuración pública (alertSender lanza)
 * quedan en el registro del servidor, solo con el asunto (sin nombres).
 */
export async function runSecurityAlerts(db: Db, now: Date = new Date(), deps: { send?: Send } = {}): Promise<{ delivered: number }> {
  let send = deps.send;
  if (!send) {
    try {
      send = alertSender();
    } catch {
      send = async (subject) => {
        console.warn(`[alerta] ${subject} (sin ALERT_EMAIL configurado: revisa el panel o configura el correo)`);
      };
    }
  }
  return { delivered: await deliverSecurityAlerts(db, send, { now }) };
}
