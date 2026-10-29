import type { Notifier, SendRequest } from "./ports";

// Tests y e2e: guarda cada envío en memoria. `failWith` simula un proveedor que rechaza o se cae.

export class MemoryNotifier implements Notifier {
  readonly sent: SendRequest[] = [];
  private seq = 0;
  /** Si se define, el próximo envío lanza este error (y se limpia). */
  failWith: Error | null = null;

  async send(request: SendRequest): Promise<{ providerMessageId: string }> {
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
    this.sent.push(structuredClone(request));
    return { providerMessageId: `memory-${++this.seq}` };
  }

  /** El último código enviado a ese destino (los tests lo usan para verificar). */
  lastCode(to?: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const s = this.sent[i]!;
      if (s.template === "otp" && (to === undefined || s.to === to)) return s.params.code;
    }
    return undefined;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
