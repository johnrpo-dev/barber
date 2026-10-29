import { expireHolds } from "@/db/appointments";
import type { Db } from "@/db/types";

/** Cada minuto: vence las retenciones en línea que nadie verificó a tiempo (todas las sedes). */
export async function runExpireHolds(db: Db, now: Date = new Date()): Promise<{ expired: number }> {
  return { expired: await expireHolds(db, null, now) };
}
