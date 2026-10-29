import { type DeliveryContext, type DeliveryOutcome, scanNotifications } from "@/db/notifications";
import type { Db } from "@/db/types";
import { deriveManageToken } from "@/domain/links/manage-token";
import { alertSender, notifier as defaultNotifier } from "@/lib/notify";
import type { Notifier } from "@/lib/notify/ports";
import { bucketHash, type PublicConfig, publicBookingReadiness, publicConfig } from "@/lib/public-readiness";

/** Contexto de entrega a partir de la configuración: el enlace se recalcula, nunca se guarda. */
export function deliveryContext(config: PublicConfig, alert?: DeliveryContext["alert"]): DeliveryContext {
  return {
    hash: (value) => bucketHash(value, config.otpPepper),
    manageUrl: (publicId, generation) => `${config.baseUrl}/cita/${deriveManageToken(config.manageLinkSecret, publicId, generation)}`,
    bookingUrl: `${config.baseUrl}/reservar`,
    caps: config.caps,
    channels: config.channels,
    alert,
  };
}

let lastWarning: string | null = null;

/**
 * Cada minuto: crea los recordatorios que tocan y entrega lo pendiente. Sin configuración real
 * (cualquier NODE_ENV que no sea development/test, incluso sin definir, sin secretos o sin
 * WhatsApp) no toca nada: ni consola ni "enviado". Lo deja en el registro y falla cerrado.
 */
export async function runScanNotifications(
  db: Db,
  now: Date = new Date(),
  deps: { notifier?: Notifier; config?: PublicConfig } = {},
): Promise<{ skipped: true } | { created: number; outcomes: Record<DeliveryOutcome, number> }> {
  let config: PublicConfig;
  try {
    config = deps.config ?? publicConfig();
  } catch {
    // Solo los nombres de lo que falta, nunca valores. Una vez por cambio, no cada minuto.
    const missing = publicBookingReadiness().missing.join(", ");
    const warning = `[worker] notificaciones en pausa: falta configuración (${missing || "NODE_ENV"}); NODE_ENV=${process.env.NODE_ENV ?? "(sin definir)"}`;
    if (warning !== lastWarning) console.warn(warning);
    lastWarning = warning;
    return { skipped: true };
  }
  lastWarning = null;
  const ctx = deliveryContext(config, deps.config ? undefined : alertSender());
  return scanNotifications(db, deps.notifier ?? defaultNotifier(), ctx, now);
}
