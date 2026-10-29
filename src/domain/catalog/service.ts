import { type Money, PESO } from "../money";

// Servicio del catálogo (corte, barba, combo…). El precio y la comisión se copian
// a cada venta al cobrar, así que cambiar el catálogo no altera el histórico.

export interface ServiceDraft {
  readonly name: string;
  readonly durationMin: number;
  /** Margen de limpieza después del servicio. */
  readonly bufferMin: number;
  readonly price: Money;
  /** Comisión del barbero en puntos básicos: 4000 = 40 %. */
  readonly commissionBps: number;
}

export class InvalidServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidServiceError";
  }
}

export function assertValidService(s: ServiceDraft): void {
  const name = s.name.trim();
  if (name.length < 2 || name.length > 80) {
    throw new InvalidServiceError("El nombre debe tener entre 2 y 80 caracteres");
  }
  if (!Number.isInteger(s.durationMin) || s.durationMin < 5 || s.durationMin > 480 || s.durationMin % 5 !== 0) {
    throw new InvalidServiceError("La duración debe ser de 5 a 480 minutos, en múltiplos de 5");
  }
  if (!Number.isInteger(s.bufferMin) || s.bufferMin < 0 || s.bufferMin > 120 || s.bufferMin % 5 !== 0) {
    throw new InvalidServiceError("El margen debe ser de 0 a 120 minutos, en múltiplos de 5");
  }
  if (s.price.minor < 0n || s.price.minor % PESO !== 0n) {
    throw new InvalidServiceError("El precio debe ser un valor en pesos enteros, sin centavos");
  }
  if (!Number.isInteger(s.commissionBps) || s.commissionBps < 0 || s.commissionBps > 10_000) {
    throw new InvalidServiceError("La comisión debe estar entre 0 % y 100 %");
  }
}

/** "40" o "40,5" (porcentaje escrito por el dueño) → puntos básicos, sin pasar por float. */
export function percentToBps(input: string): number {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!match) throw new InvalidServiceError(`Porcentaje inválido: ${input}`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + fraction;
}
