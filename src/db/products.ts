import { and, asc, eq, sql } from "drizzle-orm";
import type { AuditValue } from "@/domain/audit/events";
import { MAX_PRODUCTS } from "@/domain/inventory/periodic";
import { assertValidProduct, cleanProductDraft, InventoryError, type ProductDraft } from "@/domain/inventory/product";
import { money, type Money } from "@/domain/money";
import { inventoryDocumentLines, inventoryDocuments, products } from "./schema";
import type { Db } from "./types";

// Catálogo de productos (sprint 6, docs/sprint-6-productos-inventario.md). Se edita, no se borra: las
// compras, los conteos y (desde la fase C) las ventas los nombran. Cambiar un precio no toca nada ya
// registrado. La base exige lo mismo con CHECK, un índice único por nombre (sin mayúsculas) y un
// trigger que no deja borrar (0032).

export interface Product {
  id: bigint;
  publicId: string;
  name: string;
  sku: string | null;
  price: Money;
  commissionBps: number;
  active: boolean;
}

const columns = {
  id: products.id,
  publicId: products.publicId,
  name: products.name,
  sku: products.sku,
  price: products.price,
  commissionBps: products.commissionBps,
  active: products.active,
};

function toProduct(row: { price: bigint } & Omit<Product, "price">): Product {
  return { ...row, price: money(row.price) };
}

function values(draft: ProductDraft) {
  assertValidProduct(draft);
  const clean = cleanProductDraft(draft);
  return { name: clean.name, sku: clean.sku, price: clean.price.minor, commissionBps: clean.commissionBps };
}

/** El índice único por nombre (o referencia), sin mayúsculas, se traduce a un mensaje para el dueño. */
function duplicate(err: unknown): never {
  for (let e: unknown = err; e instanceof Error; e = (e as Error & { cause?: unknown }).cause) {
    if (e.message.includes("products_location_name_key")) throw new InventoryError("Ya existe un producto con ese nombre");
    if (e.message.includes("products_location_sku_key")) throw new InventoryError("Ya existe un producto con esa referencia");
  }
  throw err;
}

export async function createProduct(db: Db, input: { locationId: bigint; draft: ProductDraft; active?: boolean }): Promise<Product> {
  // Los productos no se borran y el conteo exige contarlos (activos o con movimientos): con un tope
  // por debajo de las líneas que acepta un conteo, el conteo mensual nunca se bloquea (auditoría B-2).
  const [existing] = await db.select({ n: sql<number>`count(*)::int` }).from(products).where(eq(products.locationId, input.locationId));
  if ((existing?.n ?? 0) >= MAX_PRODUCTS) throw new InventoryError(`Una sede tiene a lo sumo ${MAX_PRODUCTS} productos; retira y reutiliza los que ya no vendes`);
  const [row] = await db
    .insert(products)
    .values({ locationId: input.locationId, ...values(input.draft), active: input.active ?? true })
    .returning(columns)
    .catch(duplicate);
  if (!row) throw new Error("No se pudo crear el producto");
  return toProduct(row);
}

export async function updateProduct(db: Db, input: { locationId: bigint; productId: bigint; draft: ProductDraft; active: boolean }): Promise<Product> {
  const [row] = await db
    .update(products)
    .set({ ...values(input.draft), active: input.active, updatedAt: sql`now()` })
    .where(and(eq(products.locationId, input.locationId), eq(products.id, input.productId)))
    .returning(columns)
    .catch(duplicate);
  if (!row) throw new InventoryError("El producto no existe en esta sede");
  return toProduct(row);
}

/** Retirar un producto del catálogo sin borrarlo (lo ya registrado lo sigue nombrando). */
export async function setProductActive(db: Db, input: { locationId: bigint; productId: bigint; active: boolean }): Promise<void> {
  const updated = await db
    .update(products)
    .set({ active: input.active, updatedAt: sql`now()` })
    .where(and(eq(products.locationId, input.locationId), eq(products.id, input.productId)))
    .returning({ id: products.id });
  if (updated.length === 0) throw new InventoryError("El producto no existe en esta sede");
}

/** Un producto de la sede, o null si no existe en esa sede. `forUpdate`: bloqueado para editarlo. */
export async function productOf(db: Db, input: { locationId: bigint; productId: bigint; forUpdate?: boolean }): Promise<Product | null> {
  const query = db
    .select(columns)
    .from(products)
    .where(and(eq(products.locationId, input.locationId), eq(products.id, input.productId)));
  const [row] = input.forUpdate ? await query.for("update") : await query;
  return row ? toProduct(row) : null;
}

export async function listProducts(db: Db, input: { locationId: bigint; activeOnly?: boolean }): Promise<Product[]> {
  const where = input.activeOnly
    ? and(eq(products.locationId, input.locationId), eq(products.active, true))
    : eq(products.locationId, input.locationId);
  const rows = await db.select(columns).from(products).where(where).orderBy(asc(sql`lower(${products.name})`), asc(products.id));
  return rows.map(toProduct);
}

/** Foto para la bitácora (lista blanca AUDIT_FIELDS.product): dinero y puntos básicos como texto. */
export async function productSnapshot(tx: Db, locationId: bigint, productId: bigint): Promise<Record<string, AuditValue> | null> {
  const [row] = await tx
    .select({ name: products.name, sku: products.sku, price: products.price, commissionBps: products.commissionBps, active: products.active })
    .from(products)
    .where(and(eq(products.locationId, locationId), eq(products.id, productId)))
    .for("update");
  if (!row) return null;
  return { name: row.name, sku: row.sku, price: row.price.toString(), commissionBps: row.commissionBps.toString(), active: row.active };
}

/**
 * La línea de la ÚLTIMA compra vigente de cada producto de la sede (la de mayor documento, sin contar
 * las anuladas): de ahí sale su costo unitario (amount / quantity). Un producto sin compras no aparece.
 */
export async function lastPurchases(db: Db, locationId: bigint): Promise<Map<bigint, { quantity: number; amount: Money }>> {
  const rows = await db
    .selectDistinctOn([inventoryDocumentLines.productId], {
      productId: inventoryDocumentLines.productId,
      quantity: inventoryDocumentLines.quantity,
      amount: inventoryDocumentLines.amount,
    })
    .from(inventoryDocumentLines)
    .innerJoin(
      inventoryDocuments,
      and(eq(inventoryDocuments.locationId, inventoryDocumentLines.locationId), eq(inventoryDocuments.id, inventoryDocumentLines.documentId)),
    )
    .where(
      and(
        eq(inventoryDocumentLines.locationId, locationId),
        eq(inventoryDocuments.kind, "purchase"),
        // Una compra anulada (su asiento tiene reversa, 0033) no da el costo: casi siempre era un error.
        sql`not exists (select 1 from journal_entries r where r.location_id = ${inventoryDocuments.locationId} and r.reverses_entry_id = ${inventoryDocuments.journalEntryId})`,
      ),
    )
    .orderBy(inventoryDocumentLines.productId, sql`${inventoryDocuments.id} desc`);
  return new Map(rows.map((r) => [r.productId, { quantity: r.quantity, amount: money(r.amount) }]));
}
