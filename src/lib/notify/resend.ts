import { renderEmail } from "@/domain/notifications/templates";
import { type Notifier, NotifyError, type SendRequest } from "./ports";

// Correo con Resend (https://resend.com/docs/api-reference/emails/send-email). La cabecera
// Idempotency-Key es la clave de deduplicación: si el mismo envío llega dos veces, Resend
// manda uno solo.

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

export interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export function buildResendPayload(request: SendRequest, from: string): ResendPayload {
  const to = request.to.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("Destino de correo inválido");
  const { subject, html, text } = renderEmail(request.template, request.params);
  return { from, to: [to], subject, html, text };
}

/** Un correo sin plantilla, solo para avisos al dueño (alerta de cuota). */
export function buildAlertPayload(from: string, to: string, subject: string, text: string): ResendPayload {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { from, to: [to], subject: subject.replace(/[\r\n]+/g, " "), text, html: `<pre style="font-family:system-ui,sans-serif">${esc}</pre>` };
}

export class ResendNotifier implements Notifier {
  constructor(
    private readonly config: { apiKey: string; from: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async post(payload: ResendPayload, idempotencyKey: string): Promise<{ providerMessageId: string }> {
    const res = await this.fetchImpl(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
    if (!res.ok) throw new NotifyError(`resend_${res.status}${typeof data.name === "string" ? `_${data.name.slice(0, 40)}` : ""}`);
    if (typeof data.id !== "string") throw new Error("Resend respondió sin id de mensaje");
    return { providerMessageId: data.id };
  }

  send(request: SendRequest): Promise<{ providerMessageId: string }> {
    return this.post(buildResendPayload(request, this.config.from), request.idempotencyKey);
  }
}
