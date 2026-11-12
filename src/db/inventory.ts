import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import {
  countAdjustmentEntry,
  type CountedLine,
  expectedUnits,
  isLastDayOfMonth,
  unitDifference,
  type UnitMovement,
  PAID_FROM_LABELS,
  type PurchaseLine,
  type PurchasePaidFrom,
  purchaseEntry,
  purchaseTotal,
  valueCount,
  type ValuedLine,
} from "@/domain/inventory/periodic";
import { cleanSupplierName, dueDateFor } from "@/domain/inventory/payables";
import { InventoryError } from "@/domain/inventory/product";
import { format, type Money, money } from "@/domain/money";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import { can, type Role } from "@/domain/staff/roles";
import { recordAudit } from "./audit";
import { type ActorRef, cashShortError, ledgerCash, requireOpenDay, requireOpenSession, today } from "./cash";
import { accountBalance, postEntry, reverseEntry } from "./ledger";
import { lastPurchases } from "./products";
import { cashMovements, cashSessions, inventoryDocumentLines, inventoryDocuments, journalEntries, products, suppliers } from "./schema";
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
 * ni un conteo mezclado con una compra a medio registrar. Es un UPDATE de la fila de la sede en
 * inventory_locks (0035), no un candado consultivo: en SERIALIZABLE la foto se toma antes de esperar,
 * y solo el UPDATE de una fila que otra transacción ya cambió garantiza el 40001 que hace repetir con
 * datos frescos (auditoría del sprint 6, M-1). Se llama antes de leer saldos o últimas compras.
 */
export async function lockInventory(tx: Db, locationId: bigint): Promise<void> {
  await tx.execute(sql`
    insert into inventory_locks (location_id, version) values (${locationId}::bigint, 1)
    on conflict (location_id) do update set version = inventory_locks.version + 1
  `);
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

/** Compra a crédito (sprint 8, parte A): a quién se le debe y en cuántos días vence. */
export interface CreditTerms {
  /** Nombre del proveedor: si no existe en la sede (sin mayúsculas), se crea. */
  supplierName: string;
  /** Plazo en días desde el día contable de la compra (0 a MAX_TERM_DAYS). */
  termDays: number;
}

/**
 * El proveedor de la sede con ese nombre (sin distinguir mayúsculas), o uno nuevo. Se llama con el
 * candado de inventario tomado: dos compras a crédito con el mismo proveedor nuevo no chocan.
 */
async function supplierFor(tx: Db, locationId: bigint, name: string, createdBy: string): Promise<{ id: bigint; name: string }> {
  const [found] = await tx
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(and(eq(suppliers.locationId, locationId), sql`lower(${suppliers.name}) = lower(${name})`));
  if (found) return found;
  const [created] = await tx.insert(suppliers).values({ locationId, name, createdBy }).returning({ id: suppliers.id, name: suppliers.name });
  return created!;
}

export interface RecordPurchaseInput {
  locationId: bigint;
  paidFrom: PurchasePaidFrom;
  lines: readonly PurchaseLine[];
  /** Solo en la compra a crédito (paidFrom "credit"), y ahí es obligatorio. */
  credit?: CreditTerms | null;
  note?: string | null;
  idempotencyKey: string;
  /** Con su rol: la caja exige inventory.purchase; el banco y la carga inicial, inventory.manage. */
  actor: ActorRef & { role: Role };
  now?: Date;
}

/** Permiso que exige una compra según de dónde sale el dinero (también lo usan las acciones). A crédito: solo el dueño. */
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
  if ((input.paidFrom === "credit") !== !!input.credit) {
    throw new InventoryError(input.paidFrom === "credit" ? "Escribe el proveedor y el plazo de la compra a crédito" : "Solo la compra a crédito lleva proveedor y plazo");
  }
  const credit = input.credit ? { supplierName: cleanSupplierName(input.credit.supplierName), termDays: input.credit.termDays } : null;
  // Valida el plazo antes de tocar nada (la fecha real sale del día contable, más abajo).
  if (credit) dueDateFor("2000-01-01", credit.termDays);
  // El orden de las líneas no cambia la compra: la huella las ordena por producto. La compra que no
  // es a crédito conserva la huella de siempre (sin el campo credit).
  const sorted = [...input.lines].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  const hash = requestHash({
    kind: "inventory_purchase",
    locationId: input.locationId,
    paidFrom: input.paidFrom,
    lines: sorted.map((l) => ({ productId: l.productId, quantity: l.quantity, amount: l.amount.minor })),
    note,
    by: input.actor.userId,
    ...(credit ? { credit: { supplier: credit.supplierName.toLowerCase(), termDays: credit.termDays } } : {}),
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
  const supplier = credit ? await supplierFor(tx, input.locationId, credit.supplierName, input.actor.userId) : null;
  const dueDate = credit ? dueDateFor(day, credit.termDays) : null;

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
      supplierId: supplier?.id ?? null,
      dueDate,
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
    summary: `Registró una compra de mercancía de ${format(total)} (${sorted.length} ${sorted.length === 1 ? "producto" : "productos"}), ${
      supplier ? `a crédito con ${supplier.name}, vence el ${dueDate}` : `pagada ${PAID_FROM_LABELS[input.paidFrom]}`
    }`,
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

// ─── Anular una compra ───────────────────────────────────────────────────────

export interface ReversePurchaseInput {
  locationId: bigint;
  documentId: bigint;
  actor: ActorRef & { role: Role };
  now?: Date;
}

/** Por qué una compra no se puede anular, o null si se puede (lo mismo que exigen 0033 y 0036). */
export type PurchaseLock = "reversed" | "counted" | "session_closed" | "has_payments" | null;

export const PURCHASE_LOCK_MESSAGES: Record<Exclude<PurchaseLock, null>, string> = {
  reversed: "Esta compra ya está anulada",
  counted: "Esta compra ya entró en un conteo de inventario: no se puede anular. La diferencia se corrige en el próximo conteo.",
  session_closed: "Esta compra salió de un turno de caja que ya se cerró: no se puede anular (el arqueo de ese turno ya la tuvo en cuenta).",
  has_payments: "Esta compra tiene pagos al proveedor: anula primero esos pagos en Cuentas por pagar.",
};

/**
 * Anula una compra mal registrada (solo el dueño, inventory.manage). No borra nada: asienta la
 * reversa exacta de su asiento en el día contable de hoy. La de caja devuelve el efectivo a SU turno,
 * que debe seguir abierto. No se anula si hubo un conteo después (ya fijó el inventario). Repetir sobre
 * una compra anulada devuelve created: false. La base exige las mismas reglas al COMMIT (0033).
 */
export function reversePurchase(db: Db, input: ReversePurchaseInput): Promise<{ total: Money; paidFrom: PurchasePaidFrom; created: boolean }> {
  return serializable(db, async (tx) => {
    if (!can(input.actor.role, "inventory.manage")) throw new InventoryError("Solo el dueño anula compras de mercancía");
    await lockInventory(tx, input.locationId);
    const [doc] = await tx
      .select({
        id: inventoryDocuments.id,
        kind: inventoryDocuments.kind,
        paidFrom: inventoryDocuments.paidFrom,
        total: inventoryDocuments.total,
        entryId: inventoryDocuments.journalEntryId,
        sessionId: inventoryDocuments.cashSessionId,
      })
      .from(inventoryDocuments)
      .where(and(eq(inventoryDocuments.locationId, input.locationId), eq(inventoryDocuments.id, input.documentId)));
    if (!doc || doc.kind !== "purchase" || !doc.paidFrom || doc.entryId === null) throw new InventoryError("La compra no existe en esta sede");
    const paidFrom = doc.paidFrom as PurchasePaidFrom;
    const total = money(doc.total);

    const lock = await purchaseLock(tx, input.locationId, { id: doc.id, entryId: doc.entryId, paidFrom, sessionId: doc.sessionId });
    if (lock === "reversed") return { total, paidFrom, created: false };
    if (lock) throw new InventoryError(PURCHASE_LOCK_MESSAGES[lock]);

    // El efectivo vuelve al turno de la compra: tiene que ser la caja abierta de hoy (bloqueada).
    const session = paidFrom === "cash" ? await requireOpenSession(tx, input.locationId, PURCHASE_LOCK_MESSAGES.session_closed, input.now) : null;
    if (session && session.id !== doc.sessionId) throw new InventoryError(PURCHASE_LOCK_MESSAGES.session_closed);
    const day = await requireOpenDay(tx, input.locationId, input.now ?? new Date(), (m) => new InventoryError(m));

    const reversal = await reverseEntry(tx, {
      locationId: input.locationId,
      entryId: doc.entryId,
      businessDate: day,
      reason: `Anulación de la compra de mercancía ${doc.id}`,
      createdBy: input.actor.userId,
    });
    if (session) {
      await tx.insert(cashMovements).values({
        locationId: input.locationId,
        cashSessionId: session.id,
        kind: "reversal",
        journalEntryId: reversal.entryId,
        description: "Anulación de una compra de mercancía",
        createdBy: input.actor.userId,
      });
    }
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "inventory.purchase_reverse",
      targetKind: "inventory_document",
      targetRef: doc.id.toString(),
      summary: `Anuló una compra de mercancía de ${format(total)}, pagada ${PAID_FROM_LABELS[paidFrom]}`,
    });
    return { total, paidFrom, created: true };
  });
}

/** La regla de la anulación para una compra (sin tocar nada): ya anulada, contada o de un turno cerrado. */
async function purchaseLock(
  tx: Db,
  locationId: bigint,
  doc: { id: bigint; entryId: bigint; paidFrom: PurchasePaidFrom; sessionId: bigint | null },
): Promise<PurchaseLock> {
  const [reversed] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.locationId, locationId), eq(journalEntries.reversesEntryId, doc.entryId)));
  if (reversed) return "reversed";
  const [counted] = await tx
    .select({ id: inventoryDocuments.id })
    .from(inventoryDocuments)
    .where(and(eq(inventoryDocuments.locationId, locationId), eq(inventoryDocuments.kind, "count"), sql`${inventoryDocuments.id} > ${doc.id}`))
    .limit(1);
  if (counted) return "counted";
  if (doc.paidFrom === "credit" && (await hasActivePayments(tx, locationId, doc.id))) return "has_payments";
  if (doc.paidFrom === "cash") {
    const [session] = await tx
      .select({ closedAt: cashSessions.closedAt })
      .from(cashSessions)
      .where(and(eq(cashSessions.locationId, locationId), eq(cashSessions.id, doc.sessionId ?? -1n)));
    if (!session || session.closedAt !== null) return "session_closed";
  }
  return null;
}

/** ¿La compra a crédito tiene pagos sin anular? (Mientras los tenga, no se anula.) */
async function hasActivePayments(tx: Db, locationId: bigint, documentId: bigint): Promise<boolean> {
  const [row] = rowsOf<{ active: boolean }>(
    await tx.execute(sql`
      select exists (
        select 1 from supplier_payments p
         where p.location_id = ${locationId}::bigint and p.document_id = ${documentId}::bigint
           and not exists (select 1 from journal_entries r where r.location_id = p.location_id and r.reverses_entry_id = p.journal_entry_id)
      ) as active
    `),
  );
  return !!row?.active;
}

export interface RecentPurchase {
  id: bigint;
  businessDate: string;
  paidFrom: PurchasePaidFrom;
  total: Money;
  note: string | null;
  /** "Cera para peinar (6 u.) y 1 más" */
  summary: string;
  /** A crédito: el proveedor. */
  supplierName: string | null;
  lock: PurchaseLock;
}

/** Las últimas compras de la sede (más nuevas primero), con si se pueden anular y por qué no. */
export async function recentPurchases(db: Db, locationId: bigint, limit = 15): Promise<RecentPurchase[]> {
  const rows = rowsOf<{
    id: string;
    business_date: string;
    paid_from: PurchasePaidFrom;
    total: string;
    note: string | null;
    entry_id: string;
    session_id: string | null;
    first_name: string;
    first_qty: number;
    lines: number;
    reversed: boolean;
    counted: boolean;
    session_closed: boolean | null;
    supplier_name: string | null;
    has_payments: boolean;
  }>(
    await db.execute(sql`
      select d.id::text, d.business_date::text, d.paid_from, d.total::text, d.note, d.journal_entry_id::text as entry_id,
             d.cash_session_id::text as session_id,
             f.name as first_name, f.quantity as first_qty,
             (select count(*)::int from inventory_document_lines l where l.location_id = d.location_id and l.document_id = d.id) as lines,
             exists (select 1 from journal_entries r where r.location_id = d.location_id and r.reverses_entry_id = d.journal_entry_id) as reversed,
             exists (select 1 from inventory_documents c where c.location_id = d.location_id and c.kind = 'count' and c.id > d.id) as counted,
             (select s.closed_at is not null from cash_sessions s where s.location_id = d.location_id and s.id = d.cash_session_id) as session_closed,
             (select sp.name from suppliers sp where sp.location_id = d.location_id and sp.id = d.supplier_id) as supplier_name,
             exists (select 1 from supplier_payments p
                      where p.location_id = d.location_id and p.document_id = d.id
                        and not exists (select 1 from journal_entries r where r.location_id = p.location_id and r.reverses_entry_id = p.journal_entry_id)) as has_payments
        from inventory_documents d
        cross join lateral (
          select p.name, l.quantity from inventory_document_lines l
            join products p on p.location_id = l.location_id and p.id = l.product_id
           where l.location_id = d.location_id and l.document_id = d.id
           order by p.name limit 1
        ) f
       where d.location_id = ${locationId}::bigint and d.kind = 'purchase'
       order by d.id desc
       limit ${limit}
    `),
  );
  return rows.map((r) => ({
    id: BigInt(r.id),
    businessDate: r.business_date,
    paidFrom: r.paid_from,
    total: money(BigInt(r.total)),
    note: r.note,
    summary: r.lines > 1 ? `${r.first_name} (${r.first_qty} u.) y ${r.lines - 1} más` : `${r.first_name} (${r.first_qty} u.)`,
    supplierName: r.supplier_name,
    lock: r.reversed
      ? "reversed"
      : r.counted
        ? "counted"
        : r.has_payments
          ? "has_payments"
          : r.paid_from === "cash" && r.session_closed !== false
            ? "session_closed"
            : null,
  }));
}

// ─── Unidades: esperado vs. contado (informativo) ────────────────────────────
//
// Por producto, entre dos conteos: unidades del conteo anterior + compras vigentes − ventas. Las
// compras se ordenan contra los conteos por id (el candado de inventario las serializa); las ventas
// por la hora: cuentan las cobradas en el periodo y descuentan las anuladas en él (la unidad volvió).
// Todo se suma en SQL. No asienta nada: el dinero lo fija el conteo (1435 contra 6135).

export interface UnitsRow extends UnitMovement {
  productId: bigint;
  name: string;
  active: boolean;
  /** conteo anterior + compras − ventas (puede ser negativo). */
  expected: number;
}

export interface CountSummary {
  id: bigint;
  businessDate: string;
  /** Valor contado (la suma de sus líneas). */
  total: Money;
  /** Lo que el conteo llevó a 6135: positivo es costo de lo vendido y lo perdido; negativo, sobrante. */
  adjustment: Money;
}

async function countSummaries(db: Db, locationId: bigint, where: SQL, limit: number): Promise<CountSummary[]> {
  const rows = rowsOf<{ id: string; business_date: string; total: string; adjustment: string }>(
    await db.execute(sql`
      select d.id::text, d.business_date::text, d.total::text,
             coalesce((select sum(jl.debit - jl.credit) from journal_lines jl
                         join accounts a on a.location_id = jl.location_id and a.id = jl.account_id
                        where jl.location_id = d.location_id and jl.entry_id = d.journal_entry_id
                          and a.code = ${ACCOUNTS.costOfGoodsSold.code}), 0)::text as adjustment
        from inventory_documents d
       where d.location_id = ${locationId}::bigint and d.kind = 'count' and ${where}
       order by d.id desc
       limit ${limit}
    `),
  );
  return rows.map((r) => ({ id: BigInt(r.id), businessDate: r.business_date, total: money(BigInt(r.total)), adjustment: money(BigInt(r.adjustment)) }));
}

/** Los últimos conteos de la sede (más nuevos primero), con su valor y su ajuste. */
export function recentCounts(db: Db, locationId: bigint, limit = 6): Promise<CountSummary[]> {
  return countSummaries(db, locationId, sql`true`, limit);
}

interface UnitsQueryRow {
  id: string;
  name: string;
  active: boolean;
  base: number;
  purchased: number;
  sold: number;
  counted: number | null;
  value: string | null;
}

/**
 * Movimiento de unidades por producto desde el conteo `from` (null: desde el principio) hasta el
 * conteo `to` (null: hasta ahora). Con `to`, las filas son las líneas de ese conteo; sin él, los
 * productos que el próximo conteo exige (activos o con movimientos, lo mismo que recordCount).
 */
async function unitMovements(db: Db, locationId: bigint, from: bigint | null, to: bigint | null): Promise<UnitsQueryRow[]> {
  const rowsFilter =
    to === null
      ? sql`(p.active or exists (select 1 from inventory_document_lines l where l.location_id = p.location_id and l.product_id = p.id))`
      : sql`exists (select 1 from inventory_document_lines l where l.location_id = p.location_id and l.document_id = ${to}::bigint and l.product_id = p.id)`;
  return rowsOf<UnitsQueryRow>(
    await db.execute(sql`
      with bounds as (
        select coalesce((select created_at from inventory_documents where location_id = ${locationId}::bigint and kind = 'count' and id = ${from}::bigint),
                        '-infinity'::timestamptz) as lo,
               (select created_at from inventory_documents where location_id = ${locationId}::bigint and kind = 'count' and id = ${to}::bigint) as hi
      )
      select p.id::text as id, p.name, p.active,
             coalesce((select l.quantity from inventory_document_lines l
                        where l.location_id = p.location_id and l.document_id = ${from}::bigint and l.product_id = p.id), 0)::int as base,
             coalesce((select sum(l.quantity) from inventory_document_lines l
                         join inventory_documents d on d.location_id = l.location_id and d.id = l.document_id
                        where l.location_id = p.location_id and l.product_id = p.id and d.kind = 'purchase'
                          and d.id > coalesce(${from}::bigint, 0) and (${to}::bigint is null or d.id < ${to}::bigint)
                          and not exists (select 1 from journal_entries r where r.location_id = d.location_id and r.reverses_entry_id = d.journal_entry_id)), 0)::int as purchased,
             coalesce((select sum(case when s.created_at > b.lo and (b.hi is null or s.created_at <= b.hi) then sl.quantity else 0 end)
                            - sum(case when s.voided_at > b.lo and (b.hi is null or s.voided_at <= b.hi) then sl.quantity else 0 end)
                         from sale_lines sl
                         join sales s on s.location_id = sl.location_id and s.id = sl.sale_id
                        where sl.location_id = p.location_id and sl.product_id = p.id and sl.kind = 'product'), 0)::int as sold,
             (select l.quantity from inventory_document_lines l
               where l.location_id = p.location_id and l.document_id = ${to}::bigint and l.product_id = p.id) as counted,
             (select l.amount::text from inventory_document_lines l
               where l.location_id = p.location_id and l.document_id = ${to}::bigint and l.product_id = p.id) as value
        from products p
        cross join bounds b
       where p.location_id = ${locationId}::bigint and ${rowsFilter}
       order by p.name, p.id
    `),
  );
}

function unitsRow(r: UnitsQueryRow): UnitsRow {
  const movement = { base: r.base, purchased: r.purchased, sold: r.sold };
  return { productId: BigInt(r.id), name: r.name, active: r.active, ...movement, expected: expectedUnits(movement) };
}

export interface CountSheet {
  /** El conteo anterior, o null si es el primero. */
  lastCount: CountSummary | null;
  /** Un renglón por producto que el conteo exige, con las unidades que debería haber. */
  rows: UnitsRow[];
}

/** La hoja del próximo conteo: desde el último conteo hasta ahora. */
export async function countSheet(db: Db, locationId: bigint): Promise<CountSheet> {
  const [lastCount] = await recentCounts(db, locationId, 1);
  const rows = await unitMovements(db, locationId, lastCount?.id ?? null, null);
  return { lastCount: lastCount ?? null, rows: rows.map(unitsRow) };
}

export interface CountReportRow extends UnitsRow {
  counted: number;
  /** contado − esperado: negativo es faltante. */
  difference: number;
  /** Valor de la línea en ese conteo. */
  value: Money;
}

export interface CountReport {
  count: CountSummary;
  previous: CountSummary | null;
  rows: CountReportRow[];
}

/** Diferencias de un conteo guardado contra el anterior; null si el conteo no es de la sede. */
export async function countReport(db: Db, locationId: bigint, documentId: bigint): Promise<CountReport | null> {
  const [count] = await countSummaries(db, locationId, sql`d.id = ${documentId}::bigint`, 1);
  if (!count) return null;
  const [previous] = await countSummaries(db, locationId, sql`d.id < ${documentId}::bigint`, 1);
  const rows = await unitMovements(db, locationId, previous?.id ?? null, documentId);
  return {
    count,
    previous: previous ?? null,
    rows: rows.map((r) => {
      const counted = r.counted ?? 0;
      return { ...unitsRow(r), counted, difference: unitDifference(counted, r), value: money(BigInt(r.value ?? "0")) };
    }),
  };
}

/**
 * ¿Toca contar hoy? Último día del mes en la sede, hay productos que contar y todavía no hay un conteo
 * con el día contable de hoy. Lo usan Inicio (recordatorio) y Productos.
 */
export async function countDueToday(db: Db, locationId: bigint, now: Date = new Date()): Promise<boolean> {
  const { businessDate: day } = await today(db, locationId, now);
  if (!isLastDayOfMonth(day)) return false;
  const [row] = rowsOf<{ products: boolean; counted: boolean }>(
    await db.execute(sql`
      select exists (select 1 from products p where p.location_id = ${locationId}::bigint and p.active) as products,
             exists (select 1 from inventory_documents d where d.location_id = ${locationId}::bigint and d.kind = 'count' and d.business_date = ${day}::date) as counted
    `),
  );
  return !!row?.products && !row.counted;
}

/** Saldo de 1435 (inventario según el libro), sumado en SQL. */
export function inventoryBalance(db: Db, locationId: bigint): Promise<bigint> {
  return accountBalance(db, locationId, ACCOUNTS.inventory.code);
}
