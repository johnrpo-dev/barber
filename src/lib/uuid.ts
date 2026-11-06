// UUID v4 para claves de idempotencia y del formulario, generado en el navegador.
//
// crypto.randomUUID solo existe en contextos seguros (HTTPS o localhost) y en navegadores
// recientes. Desde el celular por la red local (http://192.168.x.x) o con un Safari viejo no está,
// y un identificador improvisado ("1793…-abc") lo rechaza el servidor ("Identificador inválido").
// getRandomValues sí existe en contextos no seguros: con él se arma un v4 con el mismo formato.

const hex = (b: number) => b.toString(16).padStart(2, "0");

/** Un UUID v4 válido, también fuera de HTTPS. */
export function newUuid(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // versión 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variante RFC 4122
  const h = Array.from(bytes, hex).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
