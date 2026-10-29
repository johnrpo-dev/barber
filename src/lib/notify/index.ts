import type { NotificationChannel } from "@/domain/notifications/templates";
import { allowsDevFallbacks, publicConfig } from "../public-readiness";
import { ConsoleNotifier } from "./console";
import { ChannelRouter, type Notifier } from "./ports";
import { buildAlertPayload, ResendNotifier } from "./resend";
import { WhatsAppNotifier } from "./whatsapp";

export type { Notifier, SendRequest } from "./ports";
export { NotifyError } from "./ports";

/**
 * El notificador según la configuración: WhatsApp y/o Resend con proveedor real; en desarrollo
 * y tests, la consola cubre los canales sin proveedor. Fuera de eso, sin WhatsApp,
 * publicConfig() ya lanzó (falla cerrado).
 */
export function notifier(): Notifier {
  const config = publicConfig();
  const byChannel: Partial<Record<NotificationChannel, Notifier>> = {};
  if (config.whatsapp) byChannel.whatsapp = new WhatsAppNotifier(config.whatsapp);
  if (config.email) byChannel.email = new ResendNotifier(config.email);
  if (allowsDevFallbacks()) {
    const consoleNotifier = new ConsoleNotifier();
    byChannel.whatsapp ??= consoleNotifier;
    byChannel.email ??= consoleNotifier;
  }
  return new ChannelRouter(byChannel);
}

/** Aviso al dueño (ALERT_EMAIL) por Resend; sin correo configurado, solo queda en el registro. */
export function alertSender(): (subject: string, text: string, idempotencyKey: string) => Promise<void> {
  const config = publicConfig();
  return async (subject, text, idempotencyKey) => {
    if (config.email && config.alertEmail) {
      await new ResendNotifier(config.email).post(buildAlertPayload(config.email.from, config.alertEmail, subject, text), idempotencyKey);
    } else {
      console.warn(`[alerta] ${subject}`);
    }
  };
}
