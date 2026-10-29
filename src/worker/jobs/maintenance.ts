import { anonymizeNeverVerifiedClients } from "@/db/clients";
import { pruneLoginThrottles } from "@/db/login-throttle";
import { checkQuotaAlert } from "@/db/notifications";
import { pruneRateLimits } from "@/db/rate-limit";
import type { Db } from "@/db/types";
import { alertSender } from "@/lib/notify";
import { publicConfig } from "@/lib/public-readiness";
import { deliveryContext } from "./scan-notifications";

/**
 * Diario a las 03:00 (Bogotá): borra contadores viejos, anonimiza a quienes nunca confirmaron
 * el código (más de 7 días, solo con retenciones vencidas) y revisa la alerta de cuota.
 */
export async function runMaintenance(db: Db, now: Date = new Date()): Promise<{ pruned: number; anonymized: number; alerts: number }> {
  // Contadores de límites (también los del ingreso) y bloqueos de cuenta ya vencidos.
  const pruned = (await pruneRateLimits(db, now)) + (await pruneLoginThrottles(db, now));
  const anonymized = await anonymizeNeverVerifiedClients(db, now);
  let alerts = 0;
  try {
    alerts = await checkQuotaAlert(db, deliveryContext(publicConfig(), alertSender()), now);
  } catch {
    // Sin configuración pública no hay envíos ni cuota que vigilar.
  }
  return { pruned, anonymized, alerts };
}
