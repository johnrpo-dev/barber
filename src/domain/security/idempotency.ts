import { createHash } from "node:crypto";

// Clave de idempotencia ligada al contenido de la petición (docs/arquitectura.md, "Seguridad").
// Reintentar con la misma clave y los mismos datos devuelve lo que ya se hizo; con la misma clave
// y otros datos es un conflicto: nunca se devuelve en silencio un resultado que no corresponde.

export class IdempotencyConflictError extends Error {
  constructor(message = "Esta solicitud ya se registró con otros datos. Recarga la pantalla y vuelve a intentar.") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

/**
 * Codificación canónica e inyectiva: dos valores dan el mismo texto si y solo si son iguales
 * (con las claves de los objetos en cualquier orden y sin contar las que valen `undefined`).
 * - texto entre comillas (JSON), números finitos, bigint con sufijo `n` (1 ≠ 1n ≠ "1"),
 *   fechas como `d"<ISO>"`, null y booleanos;
 * - arreglos en su orden; objetos planos con las claves ordenadas.
 * Cualquier otra cosa (funciones, Map, NaN…) es un error de programación.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: número no finito");
      return Object.is(value, -0) ? "0" : String(value);
    case "bigint":
      return `${value}n`;
    case "object": {
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) throw new TypeError("canonicalJson: fecha inválida");
        return `d${JSON.stringify(value.toISOString())}`;
      }
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("canonicalJson: solo objetos planos");
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: tipo no soportado (${typeof value})`);
  }
}

/** SHA-256 (hex, 64 caracteres) de la forma canónica de la petición. */
export function requestHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export type IdempotencyDecision = "new" | "replay" | "conflict";

/**
 * Qué hacer con una petición según lo guardado bajo su clave:
 * - nada guardado → "new" (se ejecuta);
 * - mismo contenido → "replay" (se devuelve el resultado original);
 * - otro contenido → "conflict".
 * Las filas anteriores a esta regla no tienen huella (null): se aceptan como reintento.
 */
export function idempotencyDecision(stored: { requestHash: string | null } | undefined, incoming: string): IdempotencyDecision {
  if (!stored) return "new";
  if (stored.requestHash === null || stored.requestHash === incoming) return "replay";
  return "conflict";
}

/** Lanza IdempotencyConflictError si lo guardado bajo la clave no es esta misma petición. */
export function assertSameRequest(stored: { requestHash: string | null }, incoming: string): void {
  if (idempotencyDecision(stored, incoming) === "conflict") throw new IdempotencyConflictError();
}
