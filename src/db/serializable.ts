import { CashError } from "@/domain/sales/cash";
import { CheckoutError } from "@/domain/sales/checkout";
import { VoidError } from "@/domain/sales/void";
import type { Db } from "./types";

// Transacciones SERIALIZABLE con reintento acotado (docs/sprint-4-cobro-caja.md §5). Cobro, caja,
// gastos y anulaciones corren aquí: si Postgres detecta que dos transacciones se cruzaron (40001)
// o un interbloqueo (40P01), la que pierde se repite desde cero, con datos frescos. Como cada
// operación lleva su clave de idempotencia, repetir nunca registra dos veces. Entre intentos hay
// una espera corta y aleatoria, para que dos transacciones que chocaron no vuelvan a chocar igual.

/** Código y restricción de un error de Postgres, aunque Drizzle lo envuelva. */
export function pgError(err: unknown): { code?: string; constraint?: string } {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, constraint, constraint_name } = e as { code?: string; constraint?: string; constraint_name?: string };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return { code, constraint: constraint ?? constraint_name };
  }
  return {};
}

/** Vale la pena repetir: conflicto de serialización, interbloqueo o dos inserciones con la misma clave. */
export function isRetryable(err: unknown): boolean {
  const { code, constraint } = pgError(err);
  if (code === "40001" || code === "40P01") return true;
  // Dos reintentos simultáneos con la misma clave: el segundo, al repetir, encuentra el primero.
  return code === "23505" && /idempotency_key$/.test(constraint ?? "");
}

/**
 * Restricciones únicas que una carrera puede disparar aunque la app verificó antes (la otra
 * transacción confirmó en medio): se traducen al mismo mensaje que da la verificación (L4).
 */
const FRIENDLY_UNIQUE: Record<string, () => Error> = {
  cash_sessions_one_open: () => new CashError("La caja ya está abierta"),
  void_requests_one_pending: () => new VoidError("Ya hay una solicitud de anulación pendiente para esta venta"),
  sales_one_paid_per_appointment: () => new CheckoutError("Esta cita ya está cobrada"),
  journal_entries_reverses_entry_id_key: () => new VoidError("Esta venta ya está anulada"),
};

/** El error de negocio que corresponde a una violación única conocida, o undefined. */
export function friendlyConstraintError(err: unknown): Error | undefined {
  const { code, constraint } = pgError(err);
  if (code !== "23505" || !constraint) return undefined;
  return FRIENDLY_UNIQUE[constraint]?.();
}

export const MAX_RETRIES = 3;

/** Espera antes del intento `attempt` (1, 2, 3…): 5–25 ms por intento, al azar. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  return Math.round(attempt * (5 + random() * 20));
}

export interface SerializableOptions {
  retries?: number;
  /** Para pruebas: cómo esperar entre intentos. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function serializable<T>(db: Db, fn: (tx: Db) => Promise<T>, opts: SerializableOptions | number = {}): Promise<T> {
  const { retries = MAX_RETRIES, sleep = defaultSleep } = typeof opts === "number" ? { retries: opts } : opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction((tx) => fn(tx as unknown as Db), { isolationLevel: "serializable" });
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw friendlyConstraintError(err) ?? err;
      await sleep(backoffMs(attempt + 1));
    }
  }
}
