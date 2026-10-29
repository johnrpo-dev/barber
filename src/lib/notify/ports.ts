import type { NotificationChannel, NotificationTemplate } from "@/domain/notifications/templates";

// Puerto de envío de mensajes al cliente. Los adaptadores (WhatsApp, Resend, consola, memoria)
// usan fetch y no agregan dependencias. Ningún adaptador registra el destino ni el código.

export interface SendRequest {
  channel: NotificationChannel;
  template: NotificationTemplate;
  /** E.164 ("+573001234567") para WhatsApp; correo en minúsculas para email. */
  to: string;
  /** Ya formateados, en el orden de TEMPLATE_PARAMS. `url` es el enlace completo. */
  params: Record<string, string>;
  /** Para que el proveedor descarte un reenvío accidental (Resend: Idempotency-Key). */
  idempotencyKey: string;
}

export interface Notifier {
  send(request: SendRequest): Promise<{ providerMessageId: string }>;
}

/**
 * El proveedor respondió y dijo que NO envió (4xx/5xx). Con un error de red o un timeout no se
 * sabe si salió: eso no es NotifyError, y quien entrega lo registra como `unknown`.
 */
export class NotifyError extends Error {
  constructor(
    /** Código corto para notification_events.error_code (sin datos personales). */
    readonly code: string,
    /** La plantilla no existe o no está aprobada: se suprime y se intenta por otro canal. */
    readonly templateUnavailable = false,
  ) {
    super(`El proveedor rechazó el envío (${code})`);
    this.name = "NotifyError";
  }
}

/** Envía cada canal por su adaptador. */
export class ChannelRouter implements Notifier {
  constructor(private readonly byChannel: Partial<Record<NotificationChannel, Notifier>>) {}

  async send(request: SendRequest): Promise<{ providerMessageId: string }> {
    const target = this.byChannel[request.channel];
    if (!target) throw new NotifyError(`no_channel_${request.channel}`);
    return target.send(request);
  }
}
