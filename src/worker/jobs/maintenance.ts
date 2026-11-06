import { anonymizeNeverVerifiedClients } from "@/db/clients";
import { pruneLoginThrottles } from "@/db/login-throttle";
import { checkQuotaAlert } from "@/db/notifications";
import { type PurgeResult, purgeExpiredPersonalData } from "@/db/privacy";
import { pruneRateLimits } from "@/db/rate-limit";
import { pruneSecurityAlerts } from "@/db/security-alerts";
import type { Db } from "@/db/types";
import { alertSender } from "@/lib/notify";
import { publicConfig } from "@/lib/public-readiness";
import { deliveryContext } from "./scan-notifications";

/**
 * Diario a las 03:00 (Bogotá): borra contadores viejos, anonimiza a quienes nunca confirmaron
 * el código (más de 7 días, solo con retenciones vencidas), purga los datos personales vencidos
 * (Ley 1581, retenciones en src/domain/clients/retention.ts), borra los navegadores recordados que
 * dejaron de servir hace más de 30 días y revisa la alerta de cuota.
 * La purga va DESPUÉS de anonimizar: los restos de un cliente recién anonimizado se borran hoy mismo.
 * Los avisos al dueño (owner_alerts, migración 0027) NO se purgan a propósito: son unas pocas filas al
 * día, la app no tiene DELETE sobre ellos, y borrar uno que aún cae en la ventana de 2 días del barrido
 * lo haría renacer y salir en otro correo.
 */
export async function runMaintenance(
  db: Db,
  now: Date = new Date(),
): Promise<{ pruned: number; anonymized: number; purged: PurgeResult; alerts: number }> {
  // Contadores de límites (también los del ingreso), bloqueos de cuenta vencidos y avisos de
  // seguridad ya entregados hace mucho.
  const pruned = (await pruneRateLimits(db, now)) + (await pruneLoginThrottles(db, now)) + (await pruneSecurityAlerts(db, now));
  const anonymized = await anonymizeNeverVerifiedClients(db, now);
  const purged = await purgeExpiredPersonalData(db);
  let alerts = 0;
  try {
    alerts = await checkQuotaAlert(db, deliveryContext(publicConfig(), alertSender()), now);
  } catch {
    // Sin configuración pública no hay envíos ni cuota que vigilar.
  }
  return { pruned, anonymized, purged, alerts };
}
