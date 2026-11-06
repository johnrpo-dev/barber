import { NOTIFICATION_CHANNELS, type NotificationChannel } from "./templates";

/**
 * Qué pasa de verdad con un mensaje al cliente (recibo, aviso) por cada canal, para no prometer en
 * la hoja de cobro un envío que no va a ocurrir:
 * - `stopped`: el worker no late (src/db/worker-heartbeat.ts); el mensaje queda en cola hasta que vuelva.
 * - `console`: en desarrollo, sin proveedor para ese canal, el worker lo escribe en su consola.
 * - `live`: hay proveedor real y el worker late.
 * `stopped` va primero: es lo que hay que arreglar antes (sin worker, ni la consola recibe nada).
 */
export type DeliveryMode = "live" | "console" | "stopped";

export function deliveryModes(input: { workerDown: boolean; consoleChannels: readonly NotificationChannel[] }): Record<NotificationChannel, DeliveryMode> {
  const mode = (channel: NotificationChannel): DeliveryMode =>
    input.workerDown ? "stopped" : input.consoleChannels.includes(channel) ? "console" : "live";
  return Object.fromEntries(NOTIFICATION_CHANNELS.map((c) => [c, mode(c)])) as Record<NotificationChannel, DeliveryMode>;
}
