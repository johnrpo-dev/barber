import type { Db } from "@/db/types";
import { recordHeartbeat } from "@/db/worker-heartbeat";
import { publicConfig } from "@/lib/public-readiness";

/**
 * El latido del worker (migración 0030). Solo late si el barrido de avisos puede entregar: con la
 * misma configuración que runScanNotifications. Si falta configuración (p. ej. NODE_ENV sin
 * definir en un computador sin credenciales), el barrido queda "en pausa" y el latido tampoco se
 * registra: Caja e Inicio dicen que los envíos están detenidos, que es lo que pasa.
 */
export async function runHeartbeat(db: Db, now: Date = new Date(), deps: { canDeliver?: () => boolean } = {}): Promise<{ beat: boolean }> {
  const canDeliver =
    deps.canDeliver ??
    (() => {
      try {
        publicConfig();
        return true;
      } catch {
        return false;
      }
    });
  if (!canDeliver()) return { beat: false };
  await recordHeartbeat(db, now);
  return { beat: true };
}
