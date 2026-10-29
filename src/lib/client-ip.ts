import { isIP } from "node:net";
import { headers } from "next/headers";
import { IP_ADDRESS_OPTIONS } from "./auth";
import { allowsDevFallbacks, bucketHash, publicConfig } from "./public-readiness";

// IP real del cliente para los límites y la evidencia del consentimiento. Misma regla que
// better-auth (src/lib/auth.ts): en X-Forwarded-For se recorre desde la derecha saltando los
// proxies de confianza; el primero que no lo es, es el cliente. El extremo izquierdo lo escribe
// quien quiera, así que nunca se toma a ciegas.

const LOCALHOST = "127.0.0.1";

function normalize(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return (mapped ? mapped[1]! : ip).toLowerCase();
}

/** La IP del cliente según las cabeceras; null si no hay una confiable. */
export function ipFromHeaders(h: Headers, production = !allowsDevFallbacks()): string | null {
  const trusted = new Set(IP_ADDRESS_OPTIONS.trustedProxies.map(normalize));
  for (const name of IP_ADDRESS_OPTIONS.ipAddressHeaders) {
    const value = h.get(name);
    if (!value) continue;
    const hops = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      const ip = normalize(hops[i]!);
      if (!isIP(ip)) break;
      if (trusted.has(ip)) continue;
      return ip;
    }
  }
  // Como better-auth: en desarrollo y tests, sin proxy, la petición viene de la máquina local.
  // Con cualquier otro NODE_ENV no se inventa una IP.
  return production ? null : LOCALHOST;
}

/**
 * La cubeta de límites para una IP: IPv4 tal cual; IPv6 colapsada a su /64, porque un solo
 * cliente suele tener la /64 entera y rotar dentro de ella saltaría los límites por IP.
 * La evidencia del consentimiento guarda la IP completa, no esto.
 */
export function ipBucketKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const groups = expandIPv6(ip);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : ip;
}

/** Los 8 grupos de 16 bits de una IPv6 (sin ceros a la izquierda); null si no se puede. */
function expandIPv6(ip: string): string[] | null {
  let text = ip.toLowerCase().split("%")[0]!;
  // Cola IPv4 incrustada (::ffff:1.2.3.4, 64:ff9b::1.2.3.4): a dos grupos hex.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => (parseInt(g, 16) || 0).toString(16));
}

/** IP del cliente de la petición en curso (server actions y route handlers). */
export async function clientIp(): Promise<string | null> {
  return ipFromHeaders(await headers());
}

/** User-agent recortado a 300 caracteres (lo que admite la evidencia del consentimiento). */
export async function clientUserAgent(): Promise<string | null> {
  const ua = (await headers()).get("user-agent");
  return ua ? ua.slice(0, 300) : null;
}

/** HMAC-SHA256 hex con el pepper: para cubetas de límites y hashes de destinatarios, nunca el dato en claro. */
export function hashForBucket(value: string, pepper: string = publicConfig().otpPepper): string {
  return bucketHash(value, pepper);
}
