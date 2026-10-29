import { TEMPLATE_PARAMS, WHATSAPP_TEMPLATE_NAMES } from "@/domain/notifications/templates";
import { type Notifier, NotifyError, type SendRequest } from "./ports";

// WhatsApp Cloud API (Graph v21.0). Solo mensajes de plantilla aprobada, idioma `es`.
// - Variables del cuerpo en el orden de TEMPLATE_PARAMS (sin `url`).
// - El botón URL de cada plantilla está configurado en Meta como "https://<dominio>/cita/{{1}}"
//   (o "https://<dominio>/{{1}}" en la de cancelación); el parámetro es el último tramo del enlace.
// - El código usa el formato de plantilla de autenticación: cuerpo con el código y botón
//   "Copiar código" (sub_type url) con el mismo código.

const GRAPH_URL = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 10_000;

/** Códigos de Meta para plantilla inexistente, pausada o con parámetros que no cuadran. */
const TEMPLATE_ERRORS = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);

type Parameter = { type: "text"; text: string };
type Component =
  | { type: "body"; parameters: Parameter[] }
  | { type: "button"; sub_type: "url"; index: "0"; parameters: Parameter[] };

export interface WhatsAppPayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "template";
  template: { name: string; language: { code: "es" }; components: Component[] };
}

/** Lo que va después de la última "/" del enlace (el token de gestión, o "reservar"). */
export function urlButtonSuffix(url: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, "");
  const suffix = path.slice(path.lastIndexOf("/") + 1);
  if (!suffix) throw new Error("El enlace no tiene un tramo final para el botón");
  return suffix;
}

/** Texto de una variable: Meta rechaza saltos de línea, tabulaciones y más de 4 espacios seguidos. */
function cleanParam(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function buildWhatsAppPayload(request: SendRequest): WhatsAppPayload {
  const to = request.to.replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(to)) throw new Error("Destino de WhatsApp inválido");
  const keys = TEMPLATE_PARAMS[request.template];
  const value = (key: string) => {
    const v = cleanParam(request.params[key] ?? "");
    if (!v) throw new Error(`Falta el parámetro "${key}" de la plantilla ${request.template}`);
    return v;
  };

  let components: Component[];
  if (request.template === "otp") {
    const code = value("code");
    components = [
      { type: "body", parameters: [{ type: "text", text: code }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
    ];
  } else {
    components = [{ type: "body", parameters: keys.filter((k) => k !== "url").map((k) => ({ type: "text" as const, text: value(k) })) }];
    if (keys.includes("url")) {
      components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: urlButtonSuffix(value("url")) }] });
    }
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: { name: WHATSAPP_TEMPLATE_NAMES[request.template], language: { code: "es" }, components },
  };
}

export class WhatsAppNotifier implements Notifier {
  constructor(
    private readonly config: { token: string; phoneNumberId: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(request: SendRequest): Promise<{ providerMessageId: string }> {
    const payload = buildWhatsAppPayload(request);
    const res = await this.fetchImpl(`${GRAPH_URL}/${this.config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { messages?: { id?: unknown }[]; error?: { code?: unknown } };
    if (!res.ok) {
      const code = typeof data.error?.code === "number" ? data.error.code : null;
      throw new NotifyError(`whatsapp_${res.status}${code ? `_${code}` : ""}`, code !== null && TEMPLATE_ERRORS.has(code));
    }
    const id = data.messages?.[0]?.id;
    // Respondió 2xx sin id: pudo salir. No es NotifyError, así que queda `unknown` y no se reintenta.
    if (typeof id !== "string") throw new Error("WhatsApp respondió sin id de mensaje");
    return { providerMessageId: id };
  }
}
