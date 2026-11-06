// Por dónde se le avisa a un cliente, y cómo se le muestra ese destino a quien cobra
// (docs/sprint-8-gastos-controles.md §2). Puro: lo usan el envío real (src/db/receipts.ts,
// src/db/notifications.ts) y la hoja de cobro, así lo que se muestra es lo que se envía.

import { formatPhone, maskEmail, maskPhone } from "@/domain/clients/client";
import type { NotificationChannel } from "./templates";

/** WhatsApp si hay celular y canal; si no, correo. null: no hay cómo avisarle. */
export function preferredChannel(
  client: { phoneE164: string | null; email: string | null },
  channels: readonly NotificationChannel[],
): { channel: NotificationChannel; to: string } | null {
  if (client.phoneE164 && channels.includes("whatsapp")) return { channel: "whatsapp", to: client.phoneE164 };
  if (client.email && channels.includes("email")) return { channel: "email", to: client.email };
  return null;
}

export interface ReceiptDestination {
  channel: NotificationChannel;
  /** "300 ••• ••67", "j•••@gmail.com", o el número completo si se acaba de teclear. */
  label: string;
}

/**
 * A dónde saldría el recibo, para mostrarlo antes de enviar (riesgo B4: un número mal tecleado
 * le manda el recibo a un tercero). Enmascarado, salvo `reveal`: el celular que quien cobra
 * acaba de teclear en un walk-in se muestra completo para leérselo al cliente.
 */
export function receiptDestination(
  client: { phoneE164: string | null; email: string | null },
  channels: readonly NotificationChannel[],
  opts: { reveal?: boolean } = {},
): ReceiptDestination | null {
  const target = preferredChannel(client, channels);
  if (!target) return null;
  if (target.channel === "whatsapp") return { channel: "whatsapp", label: opts.reveal ? formatPhone(target.to) : maskPhone(target.to) };
  return { channel: "email", label: maskEmail(target.to) };
}
