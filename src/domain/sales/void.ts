import type { Role } from "../staff/roles";

// Anulaciones (docs/sprint-4-cobro-caja.md §1 y §3): recepción solicita, el dueño aprueba con
// reautenticación y motivo. La anulación es la reversa exacta del asiento de la venta.

export class VoidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoidError";
  }
}

export const MAX_VOID_REASON = 300;

/** Motivo o nota obligatoria, sin espacios de sobra y con tope de largo. */
export function requireReason(text: string | undefined, what: string): string {
  const clean = text?.trim() ?? "";
  if (!clean) throw new VoidError(`Escribe ${what}`);
  if (clean.length > MAX_VOID_REASON) throw new VoidError(`${what[0]!.toUpperCase()}${what.slice(1)} es muy largo`);
  return clean;
}

/**
 * Quien cobró no aprueba la anulación de su propio cobro, salvo que sea el dueño (con un solo
 * dueño no hay a quién más pedírselo; queda el registro con autor, motivo y hora).
 */
export function assertCanApproveVoid(input: { approverUserId: string; approverRole: Role; chargedBy: string }): void {
  if (input.approverUserId === input.chargedBy && input.approverRole !== "owner") {
    throw new VoidError("Quien cobró no puede aprobar la anulación de su propio cobro");
  }
}
