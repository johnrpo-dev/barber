import { NOTIFICATION_CHANNELS, type NotificationChannel } from "@/domain/notifications/templates";
import { type PublicEnv, publicEnv } from "../env";
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

/**
 * Canales que notifier() le daría a la consola: en desarrollo y tests, los que no tienen proveedor
 * real. Fuera de eso, ninguno (la consola ni se construye). Para que la hoja de cobro no diga "Se
 * enviará por WhatsApp" cuando el mensaje solo va a quedar en el registro del worker.
 */
export function consoleChannels(): NotificationChannel[] {
  if (!allowsDevFallbacks()) return [];
  let config: ReturnType<typeof publicConfig>;
  try {
    config = publicConfig();
  } catch {
    return [];
  }
  return NOTIFICATION_CHANNELS.filter((channel) => (channel === "whatsapp" ? !config.whatsapp : !config.email));
}

type AlertSend = (subject: string, text: string, idempotencyKey: string) => Promise<void>;

/**
 * El correo de avisos al dueño solo necesita Resend y ALERT_EMAIL. NO depende de publicConfig():
 * un control del dinero (o de seguridad) no se puede apagar porque falte WhatsApp o Turnstile, que
 * son de la reserva pública. Cada variable se valida con los esquemas de src/lib/env.ts.
 */
function alertMail(values: PublicEnv): { email: { apiKey: string; from: string }; to: string } | null {
  if (!values.RESEND_API_KEY || !values.EMAIL_FROM || !values.ALERT_EMAIL) return null;
  return { email: { apiKey: values.RESEND_API_KEY, from: values.EMAIL_FROM }, to: values.ALERT_EMAIL };
}

const OWNER_ALERT_VARS = ["RESEND_API_KEY", "EMAIL_FROM", "ALERT_EMAIL", "PUBLIC_BASE_URL"] as const;

/**
 * Avisos al dueño del sprint 8 (src/db/owner-alerts.ts): solo con RESEND_API_KEY, EMAIL_FROM,
 * ALERT_EMAIL y PUBLIC_BASE_URL válidas. Si falta alguna (o viene mal), transport es null y
 * `missing` dice cuáles (solo los nombres, nunca los valores): el worker no marca los avisos y el
 * dueño los sigue viendo en Inicio. A diferencia de alertSender, nunca "envía" a la consola: un
 * aviso que no salió no puede quedar como entregado.
 */
export function ownerAlertTransport(source: Record<string, string | undefined> = process.env): {
  transport: { send: AlertSend; baseUrl: string } | null;
  missing: string[];
} {
  const { values } = publicEnv(source);
  const missing = OWNER_ALERT_VARS.filter((name) => values[name] === undefined);
  const mail = alertMail(values);
  const baseUrl = values.PUBLIC_BASE_URL;
  if (missing.length > 0 || !mail || !baseUrl) return { transport: null, missing };
  return {
    missing: [],
    transport: {
      baseUrl,
      send: async (subject, text, idempotencyKey) => {
        await new ResendNotifier(mail.email).post(buildAlertPayload(mail.email.from, mail.to, subject, text), idempotencyKey);
      },
    },
  };
}

/**
 * Aviso al dueño (ALERT_EMAIL) por Resend; sin correo configurado, solo queda en el registro. Solo
 * depende de RESEND_API_KEY, EMAIL_FROM y ALERT_EMAIL (no de la configuración de la reserva pública).
 */
export function alertSender(source: Record<string, string | undefined> = process.env): AlertSend {
  const mail = alertMail(publicEnv(source).values);
  return async (subject, text, idempotencyKey) => {
    if (mail) {
      await new ResendNotifier(mail.email).post(buildAlertPayload(mail.email.from, mail.to, subject, text), idempotencyKey);
    } else {
      console.warn(`[alerta] ${subject}`);
    }
  };
}
