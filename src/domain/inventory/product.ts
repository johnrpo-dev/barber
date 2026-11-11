import { type Money, PESO } from "../money";

// Producto del catálogo (cera, aceite para barba, shampoo…). Docs: docs/sprint-6-productos-inventario.md.
// Se edita, no se borra. No guarda costo ni existencia: el costo sale de las compras y la existencia
// del conteo mensual (inventario periódico).

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

export interface ProductDraft {
  readonly name: string;
  /** Referencia del proveedor o del negocio (opcional). */
  readonly sku: string | null;
  /** Precio de venta en pesos enteros. */
  readonly price: Money;
  /** Comisión de quien vende, en puntos básicos (0 por defecto). */
  readonly commissionBps: number;
}

/** Tope sano de un monto (como los gastos): $100.000 millones. */
export const MAX_AMOUNT_MINOR = 10n ** 13n;

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Nombre y referencia limpios (sin espacios de más); la base exige lo mismo con CHECK. */
export function cleanProductDraft(draft: ProductDraft): ProductDraft {
  const name = draft.name.trim().replace(/\s+/g, " ");
  const sku = draft.sku?.trim() || null;
  return { ...draft, name, sku };
}

export function assertValidProduct(draft: ProductDraft): void {
  const { name, sku, price, commissionBps } = cleanProductDraft(draft);
  if (name.length < 2 || name.length > 80 || CONTROL.test(name)) {
    throw new InventoryError("El nombre del producto debe tener entre 2 y 80 caracteres");
  }
  if (sku !== null && (sku.length > 40 || CONTROL.test(sku))) {
    throw new InventoryError("La referencia debe tener hasta 40 caracteres");
  }
  if (price.minor < 0n || price.minor % PESO !== 0n) {
    throw new InventoryError("El precio debe ser un valor en pesos enteros, sin centavos");
  }
  if (price.minor > MAX_AMOUNT_MINOR) throw new InventoryError("El precio es demasiado grande");
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new InventoryError("La comisión debe estar entre 0 % y 100 %");
  }
}
