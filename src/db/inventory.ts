import { and, eq, inArray, sql } from "drizzle-orm";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import {
  countAdjustmentEntry,
  type CountedLine,
  PAID_FROM_LABELS,
  type PurchaseLine,
  type PurchasePaidFrom,
  purchaseEntry,
  purchaseTotal,
  valueCount,
  type ValuedLine,
} from "@/domain/inventory/periodic";
import { InventoryError } from "@/domain/inventory/product";
import { format, type Money, money } from "@/domain/money";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import { can, type Role } from "@/domain/staff/roles";
import { recordAudit } from "./audit";
import { type ActorRef, cashShortError, ledgerCash, requireOpenDay, requireOpenSession } from "./cash";
import { accountBalance, postEntry } from "./ledger";
import { lastPurchases } from "./products";
import { cashMovements, inventoryDocumentLines, inventoryDocuments, products } from "./schema";
import { serializable } from "./serializable";
import { rowsOf } from "./sql";
import type { Db } from "./types";

// Inventario periódico (sprint 6, docs/sprint-6-productos-inventario.md). Cada documento (compra o
// conteo) corre en una transacción SERIALIZABLE con su clave de idempotencia ligada al contenido, su
// asiento y su bitácora, como addExpenseTx (src/db/expenses.ts). La base vuelve a verificar al hacer
// COMMIT que el documento cuadra con su asiento y que 1435/6135 solo los mueve inventario (0032).

const MAX_NOTE = 200;

function cleanNote(note: string | null | undefined): string | null {
  const clean = note?.trim().replace(/\s+/g, " ") || null;
  if (clean && clean.length > MAX_NOTE) throw new InventoryError("La nota es muy larga (hasta 200 caracteres)");
  return clean;
}

/**
 * Candado de inventario por sede (se suelta al terminar la transacción): no hay dos conteos a la vez
 * ni un conteo mezclado con una compra a medio registrar. Un candado y no FOR UPDATE: villa_app no
 * tiene UPDATE sobre accounts.
 */
async function lockInventory(tx: Db, locationId: bigint): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('villa:inventory:' || ${locationId}::bigint::text, 0))`);
}

/** Los productos pedidos existen en la sede (y, si se pide, están activos). */
async function requireProducts(tx: Db, locationId: bigint, ids: readonly bigint[], activeOnly: boolean): Promise<Map<bigint, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: products.id, name: products.name, active: products.active })
    .from(products)
    .where(and(eq(products.locationId, locationId), inArray(products.id, [...ids])));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) throw new InventoryError("Uno de los productos no existe en esta sede");
    if (activeOnly && !row.active) throw new InventoryError(`${row.name} está desactivado; actívalo en Productos para comprarlo`);
  }
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function existingDocument(tx: Db, locationId: bigint, idempotencyKey: string) {
  const [row] = await tx
    .select({ id: inventoryDocuments.id, requestHash: inventoryDocuments.requestHash, entryId: inventoryDocuments.journalEntryId })
    .from(inventoryDocuments)
    .where(and(eq(inventoryDocuments.locationId, locationId), eq(inventoryDocuments.idempotencyKey, idempotencyKey)));
  return row;
}

// ─── Compra ──────────────────────────────────────────────────────────────────

export interface RecordPurchaseInput {
  locationId: bigint;
  paidFrom: PurchasePaidFrom;
  lines: readonly PurchaseLine[];
  note?: string | null;
  idempotencyKey: string;
  /** Con su rol: la caja exige inventory.purchase; el banco y la carga inicial, inventory.manage. */
  actor: ActorRef & { role: Role };
  now?: Date;
}

/** Permiso que exige una compra según de dónde sale el dinero (también lo usan las acciones). */
export function purchasePermission(paidFrom: PurchasePaidFrom): "inventory.purchase" | "inventory.manage" {
  return paidFrom === "cash" ? "inventory.purchase" : "inventory.manage";
}

/** Una compra en su propia transacción SERIALIZABLE (con reintento). */
export function recordPurchase(db: Db, input: RecordPurchaseInput): Promise<{ documentId: bigint; total: Money; created: boolean }> {
  return serializable(db, (tx) => recordPurchaseTx(tx, input));
}

/**
 * La compra DENTRO de una transacción SERIALIZABLE abierta por quien llama. Valida, toma el candado de
 * inventario y la caja FOR UPDATE si es de efectivo, exige el día abierto y el efectivo suficiente,
 * asienta (Dr 1435 / Cr 1105, 1110 o 3105), guarda el documento con sus líneas, el movimiento de caja
 * y la bitácora. Repetir la misma clave devuelve el mismo documento (created: false); la misma clave
 * con otro contenido es un conflicto.
 */
export async function recordPurchaseTx(tx: Db, input: RecordPurchaseInput): Promise<{ documentId: bigint; total: Money; created: boolean }> {
  if (!can(input.actor.role, purchasePermission(input.paidFrom))) {
    throw new InventoryError(input.paidFrom === "cash" ? "No tienes permiso para registrar compras" : "Solo el dueño registra compras del banco o la carga inicial");
  }
  const total = purchaseTotal(input.lines);
  const note = cleanNote(input.note);
  // El orden de las líneas no cambia la compra: la huella las ordena por producto.
  const sorted = [...input.lines].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  const hash = requestHash({
    kind: "inventory_purchase",
    locationId: input.locationId,
    paidFrom: input.paidFrom,
    lines: sorted.map((l) => ({ productId: l.productId, quantity: l.quantity, amount: l.amount.minor })),
    note,
    by: input.actor.userId,
  });
  const existing = await existingDocument(tx, input.locationId, input.idempotencyKey);
  if (existing) {
    assertSameRequest(existing, hash);
    return { documentId: existing.id, total, created: false };
  }

  await lockInventory(tx, input.locationId);
  const names = await requireProducts(
    tx,
    input.locationId,
    sorted.map((l) => l.productId),
    true,
  );
  const session = input.paidFrom === "cash" ? await requireOpenSession(tx, input.locationId, "Abre la caja para registrar una compra de caja", input.now) : null;
  const day = await requireOpenDay(tx, input.locationId, input.now ?? new Date(), (m) => new InventoryError(m));
  if (session && total.minor > (await ledgerCash(tx, input.locationId))) throw cashShortError(input.actor);

  const first = names.get(sorted[0]!.productId) ?? "Producto";
  const what = sorted.length === 1 ? `${first} (${sorted[0]!.quantity} u.)` : `${first} y ${sorted.length - 1} más`;
  const memo = `Compra de mercancía: ${what}`.slice(0, 300);
  const posted = await postEntry(tx, {
    locationId: input.locationId,
    createdBy: input.actor.userId,
    entry: purchaseEntry({ total, paidFrom: input.paidFrom }, { businessDate: day, memo, idempotencyKey: `inventory:${input.idempotencyKey}` }),
  });
  const [doc] = await tx
    .insert(inventoryDocuments)
    .values({
      locationId: input.locationId,
      kind: "purchase",
      paidFrom: input.paidFrom,
      businessDate: day,
      journalEntryId: posted.entryId,
      cashSessionId: session?.id ?? null,
      total: total.minor,
      note,
      createdBy: input.actor.userId,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
    })
    .returning({ id: inventoryDocuments.id });
  await tx.insert(inventoryDocumentLines).values(
    sorted.map((l) => ({ locationId: input.locationId, documentId: doc!.id, productId: l.productId, quantity: l.quantity, amount: l.amount.minor })),
  );
  if (session) {
    await tx.insert(cashMovements).values({
      locationId: input.locationId,
      cashSessionId: session.id,
      kind: "inventory_purchase",
      journalEntryId: posted.entryId,
      description: memo.slice(0, 200),
      createdBy: input.actor.userId,
    });
  }
  // Cuántos productos, el total y de dónde salió; la nota es texto libre y no entra a la bitácora.
  await recordAudit(tx, {
    locationId: input.locationId,
    actorUserId: input.actor.userId,
    action: "inventory.purchase",
    targetKind: "inventory_document",
    targetRef: doc!.id.toString(),
    summary: `Registró una compra de mercancía de ${format(total)} (${sorted.length} ${sorted.length === 1 ? "producto" : "productos"}), pagada ${PAID_FROM_LABELS[input.paidFrom]}`,
  });
  return { documentId: doc!.id, total, created: true };
}

// ─── Conteo ──────────────────────────────────────────────────────────────────

export interface RecordCountInput {
  locationId: bigint;
  /** Una línea por producto: TODOS los activos y todos los que tienen compras (unidades 0 si no hay). */
  lines: readonly CountedLine[];
  note?: string | null;
  idempotencyKey: string;
  actor: ActorRef & { role: Role };
  now?: Date;
}

export interface RecordedCount {
  documentId: bigint;
  /** Valor contado: la suma exacta de las líneas. */
  total: Money;
  /** Saldo de 1435 antes del ajuste (SQL). */
  bookBalance: Money;
  /** saldo − contado: positivo es costo de lo vendido y lo perdido (Dr 6135). */
  adjustment: Money;
  lines: ValuedLine[];
  created: boolean;
}

/**
 * Conteo de inventario (solo el dueño, inventory.manage). Con el candado de inventario de la sede:
 * valora cada línea al costo de la última compra (dominio puro), lee el saldo de 1435 en SQL y asienta
 * el ajuste contra 6135 (o nada si ya cuadra). La base verifica al COMMIT que 1435 quede exactamente en
 * el valor contado. Repetir la clave devuelve el mismo conteo y no crea un segundo ajuste.
 */
export function recordCount(db: Db, input: RecordCountInput): Promise<RecordedCount> {
  return serializable(db, async (tx) => {
    if (!can(input.actor.role, "inventory.manage")) throw new InventoryError("Solo el dueño registra conteos de inventario");
    const note = cleanNote(input.note);
    const sorted = [...input.lines].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
    const hash = requestHash({
      kind: "inventory_count",
      locationId: input.locationId,
      lines: sorted.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      note,
      by: input.actor.userId,
    });
    const existing = await existingDocument(tx, input.locationId, input.idempotencyKey);
    if (existing) {
      assertSameRequest(existing, hash);
      // Repetición: devuelve el documento guardado. No recalcula el saldo previo ni el ajuste (ya se
      // asentó una vez); adjustment 0 dice que esta llamada no movió nada.
      const lines = await tx
        .select({ productId: inventoryDocumentLines.productId, quantity: inventoryDocumentLines.quantity, value: inventoryDocumentLines.amount })
        .from(inventoryDocumentLines)
        .where(and(eq(inventoryDocumentLines.locationId, input.locationId), eq(inventoryDocumentLines.documentId, existing.id)));
      const total = lines.reduce((s, l) => s + l.value, 0n);
      return {
        documentId: existing.id,
        total: money(total),
        bookBalance: money(total),
        adjustment: money(0n),
        lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, value: money(l.value), costKnown: true })),
        created: false,
      };
    }

    await lockInventory(tx, input.locationId);
    // El conteo es completo: un producto que no aparece se perdería del valor sin que nadie lo diga.
    const required = rowsOf<{ id: string; name: string }>(
      await tx.execute(sql`
        select p.id::text as id, p.name from products p
         where p.location_id = ${input.locationId}::bigint
           and (p.active or exists (select 1 from inventory_document_lines l where l.location_id = p.location_id and l.product_id = p.id))
      `),
    );
    const listed = new Set(sorted.map((l) => l.productId));
    const absent = required.filter((r) => !listed.has(BigInt(r.id)));
    if (absent.length > 0) throw new InventoryError(`Falta contar ${absent[0]!.name}${absent.length > 1 ? ` y ${absent.length - 1} más` : ""} (escribe 0 si no hay)`);
    await requireProducts(
      tx,
      input.locationId,
      sorted.map((l) => l.productId),
      false,
    );
    const day = await requireOpenDay(tx, input.locationId, input.now ?? new Date(), (m) => new InventoryError(m));
    const valued = valueCount(sorted, await lastPurchases(tx, input.locationId));
    const book = money(await accountBalance(tx, input.locationId, ACCOUNTS.inventory.code));
    const entry = countAdjustmentEntry(
      { bookBalance: book, countedValue: valued.total },
      { businessDate: day, memo: `Conteo de inventario: ajuste a ${format(valued.total)}`, idempotencyKey: `inventory:${input.idempotencyKey}` },
    );
    const posted = entry ? await postEntry(tx, { locationId: input.locationId, createdBy: input.actor.userId, entry }) : null;
    const [doc] = await tx
      .insert(inventoryDocuments)
      .values({
        locationId: input.locationId,
        kind: "count",
        paidFrom: null,
        businessDate: day,
        journalEntryId: posted?.entryId ?? null,
        cashSessionId: null,
        total: valued.total.minor,
        note,
        createdBy: input.actor.userId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      })
      .returning({ id: inventoryDocuments.id });
    if (valued.lines.length > 0) {
      await tx.insert(inventoryDocumentLines).values(
        valued.lines.map((l) => ({ locationId: input.locationId, documentId: doc!.id, productId: l.productId, quantity: l.quantity, amount: l.value.minor })),
      );
    }
    const adjustment = money(book.minor - valued.total.minor);
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "inventory.count",
      targetKind: "inventory_document",
      targetRef: doc!.id.toString(),
      summary: `Registró un conteo de inventario: vale ${format(valued.total)}; ajuste de ${format(adjustment)} contra el costo de ventas`,
    });
    return { documentId: doc!.id, total: valued.total, bookBalance: book, adjustment, lines: valued.lines, created: true };
  });
}

/** Saldo de 1435 (inventario según el libro), sumado en SQL. */
export function inventoryBalance(db: Db, locationId: bigint): Promise<bigint> {
  return accountBalance(db, locationId, ACCOUNTS.inventory.code);
}
