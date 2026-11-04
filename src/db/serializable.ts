import { SettlementError } from "@/domain/commissions/settlement";
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
export function pgError(err: unknown): { code?: string; constraint?: string; message?: string } {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, constraint, constraint_name, message } = e as { code?: string; constraint?: string; constraint_name?: string; message?: string };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return { code, constraint: constraint ?? constraint_name, message };
  }
  return {};
}

/** Vale la pena repetir: conflicto de serialización, interbloqueo o dos inserciones con la misma clave. */
export function isRetryable(err: unknown): boolean {
  const { code, constraint } = pgError(err);
  if (code === "40001" || code === "40P01") return true;
  // Dos reintentos simultáneos con la misma clave: el segundo, al repetir, encuentra el primero.
  // Dos comprobantes simultáneos (sprint 5): el número lo pone un trigger con un candado por sede,
  // pero en SERIALIZABLE la foto del segundo es anterior al primero; al repetir toma el siguiente.
  return code === "23505" && /(idempotency_key|_number_key)$/.test(constraint ?? "");
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
  // Sprint 5: una línea de venta se liquida (o se descuenta) una sola vez.
  commission_settlement_lines_commission_once: () =>
    new SettlementError("Alguna de estas comisiones ya se liquidó. Revisa la liquidación otra vez."),
  commission_settlement_lines_clawback_once: () =>
    new SettlementError("Alguna de estas comisiones ya se liquidó. Revisa la liquidación otra vez."),
};

/**
 * Los triggers diferidos de comisiones (0013) saltan al confirmar, cuando otra transacción cambió
 * los datos bajo una liquidación: la verificación de la app ya pasó y solo queda repetirla. Se
 * reconocen por el texto del RAISE, porque un trigger no tiene nombre de restricción propio.
 */
const SETTLEMENT_CHANGED = "La liquidación cambió mientras la confirmabas. Revísala otra vez.";
const FRIENDLY_CHECKS: readonly (readonly [RegExp, string])[] = [
  [/comisiones: .*ya se descontó en una liquidación/, "Este anticipo ya se descontó en una liquidación; revierte esa liquidación primero"],
  [/comisiones: .*\(1365\) quedaría negativo/, "Lo que debe esta persona quedaría negativo. Revisa sus anticipos y liquidaciones."],
  [/comisiones: .*solo se revierte la última/, "Solo se puede revertir la última liquidación de esta persona."],
  [/comisiones: .*dejó comisiones o anulaciones pendientes/, SETTLEMENT_CHANGED],
  [/comisiones: .*deja propinas pendientes/, SETTLEMENT_CHANGED],
];

/** El error de negocio que corresponde a una violación conocida (única o de trigger), o undefined. */
export function friendlyConstraintError(err: unknown): Error | undefined {
  const { code, constraint, message } = pgError(err);
  if (code === "23514" && message) {
    const match = FRIENDLY_CHECKS.find(([pattern]) => pattern.test(message));
    return match ? new SettlementError(match[1]) : undefined;
  }
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
