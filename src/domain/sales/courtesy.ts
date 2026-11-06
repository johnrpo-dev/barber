import { canDiscount, type Role } from "../staff/roles";
import { CheckoutError } from "./checkout";

// Cortesía (docs/sprint-8-gastos-controles.md §4): una cita atendida que el negocio regala. No es una
// venta de $0: no hay asiento, ni comisión, ni medio de pago. Es un registro aparte
// (appointment_courtesies) con el precio de lista congelado y el motivo.

export const MIN_COURTESY_REASON = 3;
export const MAX_COURTESY_REASON = 300;

/** Tope de descuento de la sede con el que se permiten cortesías: 100 % (10.000 pb). */
export const COURTESY_MAX_DISCOUNT_BPS = 10_000n;

/** Saltos de línea, caracteres de control y separadores Unicode: el motivo es siempre una línea. */
const LINE_BREAKS = new RegExp("[\u0000-\u001f\u007f20282029]+", "g");

/**
 * El motivo limpio: una sola línea (los saltos y controles pasan a espacio), sin espacios de sobra,
 * de 3 a 300 caracteres. La base exige lo mismo (appointment_courtesies_reason_check).
 */
export function courtesyReason(text: string): string {
  const clean = text.replace(LINE_BREAKS, " ").replace(/\s+/g, " ").trim();
  const length = [...clean].length;
  if (length < MIN_COURTESY_REASON) throw new CheckoutError(`Escribe el motivo de la cortesía (al menos ${MIN_COURTESY_REASON} letras)`);
  if (length > MAX_COURTESY_REASON) throw new CheckoutError(`El motivo de la cortesía es muy largo (máximo ${MAX_COURTESY_REASON} caracteres)`);
  return clean;
}

/**
 * Quién da cortesías: quien puede dar descuentos (el dueño, y recepción si la sede lo habilita), y
 * solo si el tope de descuento de la sede es 100 %. Un tope menor dice que el dueño no quiere regalar
 * servicios completos.
 */
export function courtesyAllowedBySettings(rules: { maxDiscountBps: bigint }): boolean {
  return rules.maxDiscountBps >= COURTESY_MAX_DISCOUNT_BPS;
}

export function canGiveCourtesy(role: Role, rules: { receptionCanDiscount: boolean; maxDiscountBps: bigint }): boolean {
  return canDiscount(role, rules) && courtesyAllowedBySettings(rules);
}
