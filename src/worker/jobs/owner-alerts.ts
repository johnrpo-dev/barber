import { deliverOwnerAlerts, OWNER_ALERT_WINDOW_SEC, type OwnerAlertTransport, sweepOwnerAlerts } from "@/db/owner-alerts";
import { hit } from "@/db/rate-limit";
import type { Db } from "@/db/types";
import { windowStart } from "@/domain/security/rate-limit";
import { ownerAlertTransport } from "@/lib/notify";

/**
 * Cada minuto: barre los avisos al dueño (anulación pedida, caja por revisar, día reabierto,
 * cortesía; docs/sprint-8-gastos-controles.md §3) y entrega lo pendiente, un correo por sede como
 * mucho cada 15 minutos. Sin correo configurado no marca nada y deja UNA línea en el registro por
 * ventana de 15 minutos, con el conteo y los nombres de las variables que faltan (sin valores, nombres
 * de personas, montos ni motivos).
 */
export async function runOwnerAlerts(
  db: Db,
  now: Date = new Date(),
  deps: { transport?: OwnerAlertTransport | null } = {},
): Promise<{ swept: number; delivered: number; emails: number; failed: number; pending: number }> {
  const swept = await sweepOwnerAlerts(db, now);
  const resolved = deps.transport !== undefined ? { transport: deps.transport, missing: [] as string[] } : ownerAlertTransport();
  const { transport } = resolved;
  const { delivered, emails, failed, pending } = await deliverOwnerAlerts(db, transport, { now });
  if (!transport && pending > 0 && (await hit(db, "alert:owner:unconfigured", windowStart(now, OWNER_ALERT_WINDOW_SEC))) === 1) {
    // Solo los NOMBRES de lo que falta o viene mal, nunca sus valores.
    const missing = resolved.missing.length > 0 ? resolved.missing.join(", ") : "RESEND_API_KEY, EMAIL_FROM, ALERT_EMAIL y PUBLIC_BASE_URL";
    console.warn(`[avisos] ${pending} ${pending === 1 ? "aviso" : "avisos"} al dueño sin enviar: falta ${missing}. Siguen en Inicio.`);
  }
  // Solo conteos: el worker los escribe en el registro.
  return { swept, delivered, emails, failed, pending };
}
