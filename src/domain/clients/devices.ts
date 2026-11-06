// Navegadores recordados de un cliente (client_devices, sprint 6): reglas de cuántos quedan activos
// y cuándo se borran (auditoría del sprint 6, cerrada en el sprint 7).
//
// - Como máximo MAX_ACTIVE_DEVICES activos por cliente. Al recordar uno nuevo se revocan los que
//   sobran, empezando por los que llevan más tiempo sin usarse (el último uso o, si nunca se usó,
//   cuando se recordó). El nuevo nunca se revoca.
// - Una fila revocada o vencida deja de servir; se borra DEVICE_PURGE_DAYS días después en el
//   mantenimiento diario (la base lo vuelve a exigir con un trigger, migración 0025).

export const MAX_ACTIVE_DEVICES = 5;
export const DEVICE_PURGE_DAYS = 30;

export interface ActiveDevice {
  id: bigint;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const lastSeen = (d: ActiveDevice) => (d.lastUsedAt ?? d.createdAt).getTime();

/**
 * Los navegadores activos que hay que revocar para que queden `max` contando `keepId` (el recién
 * recordado). Del más reciente al más viejo por último uso; a igual hora, el id mayor es el más nuevo.
 */
export function devicesToRevoke(active: readonly ActiveDevice[], keepId: bigint, max: number = MAX_ACTIVE_DEVICES): bigint[] {
  const others = active
    .filter((d) => d.id !== keepId)
    .sort((a, b) => lastSeen(b) - lastSeen(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const keepOthers = Math.max(0, max - 1);
  return others.slice(keepOthers).map((d) => d.id);
}
