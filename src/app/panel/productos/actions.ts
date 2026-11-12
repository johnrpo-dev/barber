"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auditActor, recordConfigChange } from "@/db/audit";
import { db } from "@/db/client";
import { recordCount, recordPurchase, reversePurchase } from "@/db/inventory";
import { createProduct, productOf, productSnapshot, setProductActive, updateProduct } from "@/db/products";
import type { Db } from "@/db/types";
import { AUDIT_FIELDS } from "@/domain/audit/events";
import { percentToBps } from "@/domain/catalog/service";
import { InventoryError, type ProductDraft } from "@/domain/inventory/product";
import { MAX_LINES, MAX_QUANTITY } from "@/domain/inventory/periodic";
import { format, fromUnits, negate } from "@/domain/money";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { idempotencyKeySchema } from "@/lib/action-schemas";
import { requirePermission, requireRecentAuth } from "@/lib/session";
import { ownerPurchaseInput, purchaseNoteSchema } from "./purchase-schema";

// Productos e inventario del dueño (sprint 6, docs/sprint-6-productos-inventario.md). Solo
// inventory.manage. La sede sale SIEMPRE de la sesión. El precio viaja como texto de pesos enteros y
// la comisión como el porcentaje que escribe el dueño: nada de dinero pasa por number.
// Crear un producto, cambiar su precio o su comisión, y registrar una compra del banco o la carga
// inicial piden reautenticación reciente (como los servicios y el gasto de banco).

const database = () => db() as unknown as Db;

const draftSchema = z.object({
  name: z.string().max(80, "El nombre debe tener entre 2 y 80 caracteres"),
  sku: z.string().max(40, "La referencia debe tener hasta 40 caracteres").optional(),
  /** Precio de venta en pesos enteros, solo dígitos. */
  priceUnits: z.string().regex(/^\d{1,10}$/, "Escribe el precio en pesos, sin centavos"),
  /** Porcentaje como lo escribe el dueño: "10" o "7,5". */
  commission: z.string().max(8),
  active: z.boolean(),
});

const updateSchema = draftSchema.extend({ productId: idSchema });
const activeSchema = z.object({ productId: idSchema, active: z.boolean() });

function toDraft(input: z.infer<typeof draftSchema>): ProductDraft {
  return {
    name: input.name,
    sku: input.sku?.trim() || null,
    price: fromUnits(BigInt(input.priceUnits)),
    commissionBps: percentToBps(input.commission),
  };
}

function refresh() {
  revalidatePath("/panel/productos");
  revalidatePath("/panel/caja");
}

export async function createProductAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("inventory.manage");
    const input = draftSchema.parse(raw);
    const draft = toDraft(input);
    requireRecentAuth(staff);
    await database().transaction(async (tx) => {
      const t = tx as unknown as Db;
      const created = await createProduct(t, { locationId: staff.locationId, draft, active: input.active });
      const after = await productSnapshot(t, staff.locationId, created.id);
      await recordConfigChange(
        t,
        { ...auditActor(staff), action: "product.create", targetKind: "product", targetRef: created.id.toString(), summary: `Creó el producto ${created.name}` },
        {},
        after!,
        AUDIT_FIELDS.product,
      );
    });
    refresh();
    return undefined;
  });
}

export async function updateProductAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("inventory.manage");
    const input = updateSchema.parse(raw);
    const draft = toDraft(input);
    await database().transaction(async (tx) => {
      const t = tx as unknown as Db;
      // Se compara con la fila bloqueada: nadie cambia el precio entre medio.
      const current = await productOf(t, { locationId: staff.locationId, productId: input.productId, forUpdate: true });
      if (!current) throw new InventoryError("El producto no existe en esta sede");
      const before = await productSnapshot(t, staff.locationId, input.productId);
      if (current.price.minor !== draft.price.minor || current.commissionBps !== draft.commissionBps) requireRecentAuth(staff);
      const updated = await updateProduct(t, { locationId: staff.locationId, productId: input.productId, draft, active: input.active });
      const after = await productSnapshot(t, staff.locationId, input.productId);
      await recordConfigChange(
        t,
        { ...auditActor(staff), action: "product.update", targetKind: "product", targetRef: input.productId.toString(), summary: `Cambió el producto ${updated.name}` },
        before!,
        after!,
        AUDIT_FIELDS.product,
      );
    });
    refresh();
    return undefined;
  });
}

export async function setProductActiveAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("inventory.manage");
    const input = activeSchema.parse(raw);
    await database().transaction(async (tx) => {
      const t = tx as unknown as Db;
      const before = await productSnapshot(t, staff.locationId, input.productId);
      if (!before) throw new InventoryError("El producto no existe en esta sede");
      await setProductActive(t, { locationId: staff.locationId, productId: input.productId, active: input.active });
      await recordConfigChange(
        t,
        {
          ...auditActor(staff),
          action: "product.active",
          targetKind: "product",
          targetRef: input.productId.toString(),
          summary: `${input.active ? "Activó" : "Retiró"} el producto ${String(before.name)}`,
        },
        before,
        { ...before, active: input.active },
        AUDIT_FIELDS.product,
      );
    });
    refresh();
    return undefined;
  });
}

/**
 * Compra de mercancía pagada del banco o carga inicial (aporte del dueño). No pasa por el conteo de
 * la caja: confirma identidad. La compra de caja va por Caja (recordCashPurchaseAction).
 */
export async function recordPurchaseAction(raw: unknown): Promise<ActionResult<{ documentId: string; totalLabel: string }>> {
  return runAction(async () => {
    const staff = await requirePermission("inventory.manage");
    const input = ownerPurchaseInput.parse(raw);
    requireRecentAuth(staff);
    const { documentId, total } = await recordPurchase(database(), {
      locationId: staff.locationId,
      paidFrom: input.paidFrom,
      lines: input.lines,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId, role: staff.role },
    });
    refresh();
    return { documentId: documentId.toString(), totalLabel: format(total) };
  });
}

const countSchema = z.object({
  lines: z
    .array(
      z.object({
        productId: idSchema,
        // Unidades contadas como dígitos (0 si no hay): nada pasa por parseFloat.
        quantity: z
          .string()
          .trim()
          .regex(/^\d{1,6}$/, "Las unidades contadas deben ser un número entero")
          .transform((v) => Number.parseInt(v, 10))
          .refine((n) => n <= MAX_QUANTITY, `Las unidades contadas deben estar entre 0 y ${MAX_QUANTITY}`),
      }),
    )
    .min(1, "No hay productos para contar")
    .max(MAX_LINES * 10, "El conteo tiene demasiados productos"),
  note: purchaseNoteSchema,
  idempotencyKey: idempotencyKeySchema,
});

/**
 * Conteo de inventario (solo el dueño, con reautenticación): deja 1435 en lo contado y lleva la
 * diferencia a 6135 (recordCount). No se deshace: un conteo nuevo lo corrige.
 */
export async function recordCountAction(
  raw: unknown,
): Promise<ActionResult<{ totalLabel: string; adjustmentLabel: string; adjustment: "cost" | "surplus" | "none"; created: boolean }>> {
  return runAction(async () => {
    const staff = await requirePermission("inventory.manage");
    const input = countSchema.parse(raw);
    requireRecentAuth(staff);
    const r = await recordCount(database(), {
      locationId: staff.locationId,
      lines: input.lines,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId, role: staff.role },
    });
    refresh();
    revalidatePath("/panel");
    const sign = r.adjustment.minor > 0n ? "cost" : r.adjustment.minor < 0n ? "surplus" : "none";
    return { totalLabel: format(r.total), adjustmentLabel: format(r.adjustment.minor < 0n ? negate(r.adjustment) : r.adjustment), adjustment: sign, created: r.created };
  });
}

const reverseSchema = z.object({ documentId: idSchema });

/**
 * Anula una compra mal registrada (solo el dueño, con reautenticación): asiento de reversa, nunca un
 * borrado. La de caja devuelve el efectivo a su turno, que debe seguir abierto; ninguna se anula si
 * hubo un conteo después (reversePurchase y la base, 0033).
 */
export async function reversePurchaseAction(raw: unknown): Promise<ActionResult<{ totalLabel: string; created: boolean }>> {
  return runAction(async () => {
    const staff = await requirePermission("inventory.manage");
    const input = reverseSchema.parse(raw);
    requireRecentAuth(staff);
    const { total, created } = await reversePurchase(database(), {
      locationId: staff.locationId,
      documentId: input.documentId,
      actor: { userId: staff.userId, role: staff.role },
    });
    refresh();
    return { totalLabel: format(total), created };
  });
}
