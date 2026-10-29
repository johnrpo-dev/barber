import { allowsDevFallbacks, publicConfig } from "./public-readiness";

// Prueba de humano para startBooking (Cloudflare Turnstile). Falla cerrado: un error de red,
// una respuesta rara o un timeout cuentan como "no es humano".

export interface HumanVerifier {
  verify(token: string, remoteIp: string | null): Promise<boolean>;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5_000;
export const TURNSTILE_ACTION = "reservar";

export class TurnstileVerifier implements HumanVerifier {
  constructor(
    private readonly secret: string,
    /** Host esperado en la respuesta (el de PUBLIC_BASE_URL). */
    private readonly hostname: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(token: string, remoteIp: string | null): Promise<boolean> {
    if (!token || token.length > 2048) return false;
    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    try {
      const res = await this.fetchImpl(SITEVERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return false;
      const data = (await res.json()) as { success?: unknown; action?: unknown; hostname?: unknown };
      return data.success === true && data.action === TURNSTILE_ACTION && data.hostname === this.hostname;
    } catch {
      return false;
    }
  }
}

/** Desarrollo y tests: acepta el token "ok". Con cualquier otro NODE_ENV no se construye. */
export class FakeVerifier implements HumanVerifier {
  constructor() {
    if (!allowsDevFallbacks()) throw new Error("FakeVerifier solo se usa en desarrollo y tests");
  }

  async verify(token: string): Promise<boolean> {
    if (!allowsDevFallbacks()) return false;
    return token === "ok";
  }
}

/** Turnstile si está configurado; si no (solo en desarrollo y tests; si no, publicConfig ya falló cerrado), el falso. */
export function humanVerifier(): HumanVerifier {
  const config = publicConfig();
  if (config.turnstile) return new TurnstileVerifier(config.turnstile.secret, new URL(config.baseUrl).hostname);
  return new FakeVerifier();
}
