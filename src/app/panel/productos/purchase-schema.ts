import { z } from "zod";
import { MAX_LINES, MAX_QUANTITY, type PurchaseLine } from "@/domain/inventory/periodic";
import { idSchema } from "@/lib/action";
import { idempotencyKeySchema, textSchema, unitsSchema } from "@/lib/action-schemas";

// Entrada de una compra de mercancía (sprint 6), compartida por Caja (de la caja) y Productos (del
// banco o carga inicial). El costo viaja como texto de pesos enteros y las unidades como dígitos: nada
// de dinero pasa por number. El dominio vuelve a validar todo (purchaseTotal) y la base también.

const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,6}$/, "Las unidades deben ser un número entero")
  .transform((v) => Number.parseInt(v, 10))
  .refine((n) => n >= 1 && n <= MAX_QUANTITY, `Las unidades deben estar entre 1 y ${MAX_QUANTITY}`);

export const purchaseLinesSchema = z
  .array(z.object({ productId: idSchema, quantity: quantitySchema, amountUnits: unitsSchema("El costo") }), "Agrega al menos un producto a la compra")
  .min(1, "Agrega al menos un producto a la compra")
  .max(MAX_LINES, `Una compra tiene a lo sumo ${MAX_LINES} productos`)
  .transform((lines): PurchaseLine[] => lines.map((l) => ({ productId: l.productId, quantity: l.quantity, amount: l.amountUnits })));

export const purchaseNoteSchema = textSchema().max(200, "La nota es muy larga (hasta 200 caracteres)").optional();

export const cashPurchaseInput = z.object({ lines: purchaseLinesSchema, note: purchaseNoteSchema, idempotencyKey: idempotencyKeySchema });

export const ownerPurchaseInput = cashPurchaseInput.extend({
  paidFrom: z.enum(["bank", "owner"], "Elige si se pagó del banco o es la carga inicial"),
});

/** Compra a crédito (sprint 8, parte A): a quién se le debe y el plazo en días, como dígitos. */
export const creditPurchaseInput = cashPurchaseInput.extend({
  supplierName: textSchema().max(80, "El nombre del proveedor debe tener entre 2 y 80 caracteres"),
  termDays: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, "Escribe el plazo en días, como un número entero")
    .transform((v) => Number.parseInt(v, 10)),
});
