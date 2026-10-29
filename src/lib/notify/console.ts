import { maskPhone } from "@/domain/clients/client";
import { allowsDevFallbacks } from "../public-readiness";
import type { Notifier, SendRequest } from "./ports";

// Solo desarrollo: en vez de enviar, imprime la plantilla, el destino enmascarado y los
// parámetros. El código de verificación se muestra (para poder probar el flujo) únicamente
// con NODE_ENV "development" o "test"; con cualquier otro esta clase ni siquiera se construye.

export function maskDestination(channel: SendRequest["channel"], to: string): string {
  if (channel === "whatsapp") return maskPhone(to);
  const [user = "", domain = ""] = to.split("@");
  return `${user.slice(0, 1)}•••@${domain}`;
}

export class ConsoleNotifier implements Notifier {
  private seq = 0;

  constructor(private readonly print: (line: string) => void = (line) => console.info(line)) {
    if (!allowsDevFallbacks()) throw new Error("ConsoleNotifier solo se usa en desarrollo y tests");
  }

  async send(request: SendRequest): Promise<{ providerMessageId: string }> {
    const params = { ...request.params };
    if ("code" in params && !allowsDevFallbacks()) params.code = "[redacted]";
    this.print(`[notify:consola] ${request.channel} ${request.template} → ${maskDestination(request.channel, request.to)} ${JSON.stringify(params)}`);
    return { providerMessageId: `console-${Date.now()}-${++this.seq}` };
  }
}
