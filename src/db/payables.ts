import { and, eq, sql } from "drizzle-orm";
import {
  assertPayment,
  DUE_SOON_DAYS,
  type DueStatus,
  dueStatus,
  outstanding,
  SUPPLIER_PAID_FROM_LABELS,
  type SupplierPaidFrom,
  supplierPaymentEntry,
} from "@/domain/inventory/payables";
import { InventoryError } from "@/domain/inventory/product";
import { ACCOUNTS } from "@/domain/ledger/accounts";
import { format, type Money, money } from "@/domain/money";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import { can, type Role } from "@/domain/staff/roles";
import { recordAudit } from "./audit";
import { type ActorRef, cashShortError, ledgerCash, requireOpenDay, requireOpenSession, today } from "./cash";
import { lockInventory } from "./inventory";
import { accountBalance, postEntry, reverseEntry } from "./ledger";
import { cashMovements, journalEntries, supplierPayments } from "./schema";
import { serializable } from "./serializable";
import { rowsOf } from "./sql";
import type { Db } from "./types";

// Cuentas por pagar a proveedores (sprint 8, parte A; docs/sprint-8-gastos-controles.md §5b). La compra a
// crédito la registra recordPurchase (paidFrom "credit"); aquí van el pago, su anulación y las lecturas.
// Cada pago corre en una transacción SERIALIZABLE con el candado de inventario de la sede (el mismo de
// compras, conteos y anulaciones: no se cruzan), su clave de idempotencia ligada al contenido, su asiento
// y su bitácora. La base vuelve a verificar al COMMIT que el pago cuadra y no supera la deuda (0036).

/** Permiso que exige un pago según de dónde sale el dinero. De la caja: dueño y recepción. */
export function supplierPaymentPermission(paidFrom: SupplierPaidFrom): "inventory.purchase" | "inventory.manage" {
  return paidFrom === "cash" ? "inventory.purchase" : "inventory.manage";
}

interface CreditPurchase {
  id: bigint;
  total: Money;
  supplierName: string;
  reversed: boolean;
}

async function creditPurchase(tx: Db, locationId: bigint, documentId: bigint): Promise<CreditPurchase | null> {
  const [row] = rowsOf<{ id: string; total: string; supplier_name: string; reversed: boolean }>(
    await tx.execute(sql`
      select d.id::text, d.total::text, s.name as supplier_name,
             exists (select 1 from journal_entries r where r.location_id = d.location_id and r.reverses_entry_id = d.journal_entry_id) as reversed
        from inventory_documents d
        join suppliers s on s.location_id = d.location_id and s.id = d.supplier_id
       where d.location_id = ${locationId}::bigint and d.id = ${documentId}::bigint and d.kind = 'purchase' and d.paid_from = 'credit'
    `),
  );
  return row ? { id: BigInt(row.id), total: money(BigInt(row.total)), supplierName: row.supplier_name, reversed: row.reversed } : null;
}

/** Suma de los pagos vigentes (sin reversa) de una compra, en SQL. */
async function paidOn(tx: Db, locationId: bigint, documentId: bigint): Promise<Money> {
  const [row] = rowsOf<{ paid: string }>(
    await tx.execute(sql`
      select coalesce(sum(p.amount), 0)::text as paid
        from supplier_payments p
       where p.location_id = ${locationId}::bigint and p.document_id = ${documentId}::bigint
         and not exists (select 1 from journal_entries r where r.location_id = p.location_id and r.reverses_entry_id = p.journal_entry_id)
    `),
  );
  return money(BigInt(row?.paid ?? "0"));
}

// ─── Pagar ───────────────────────────────────────────────────────────────────

export interface PaySupplierInput {
  locationId: bigint;
  /** La compra a crédito que se abona. */
  documentId: bigint;
  amount: Money;
  paidFrom: SupplierPaidFrom;
  idempotencyKey: string;
  actor: ActorRef & { role: Role };
  now?: Date;
}

export interface SupplierPaymentResult {
  paymentId: bigint;
  amount: Money;
  /** Lo que queda debiendo de esa compra después del pago. */
  remaining: Money;
  supplierName: string;
  created: boolean;
}

/**
 * Pago a un proveedor de UNA compra a crédito (parcial o total). De la caja exige el turno abierto
 * (FOR UPDATE) y el efectivo suficiente, y es un movimiento de caja. Repetir la clave devuelve el mismo
 * pago (created: false); la misma clave con otro contenido es un conflicto. Nunca paga de más.
 */
export function paySupplier(db: Db, input: PaySupplierInput): Promise<SupplierPaymentResult> {
  return serializable(db, async (tx) => {
    if (!can(input.actor.role, supplierPaymentPermission(input.paidFrom))) {
      throw new InventoryError(input.paidFrom === "cash" ? "No tienes permiso para pagar a proveedores" : "Solo el dueño paga a proveedores del banco o de su bolsillo");
    }
    const hash = requestHash({
      kind: "supplier_payment",
      locationId: input.locationId,
      documentId: input.documentId,
      amount: input.amount.minor,
      paidFrom: input.paidFrom,
      by: input.actor.userId,
    });
    const [existing] = await tx
      .select({ id: supplierPayments.id, requestHash: supplierPayments.requestHash, documentId: supplierPayments.documentId })
      .from(supplierPayments)
      .where(and(eq(supplierPayments.locationId, input.locationId), eq(supplierPayments.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      assertSameRequest(existing, hash);
      const doc = await creditPurchase(tx, input.locationId, existing.documentId);
      const remaining = doc ? outstanding(doc.total, await paidOn(tx, input.locationId, doc.id)) : money(0n);
      return { paymentId: existing.id, amount: input.amount, remaining, supplierName: doc?.supplierName ?? "", created: false };
    }

    await lockInventory(tx, input.locationId);
    const doc = await creditPurchase(tx, input.locationId, input.documentId);
    if (!doc) throw new InventoryError("La compra a crédito no existe en esta sede");
    if (doc.reversed) throw new InventoryError("Esta compra está anulada: no se le hacen pagos");
    const owed = outstanding(doc.total, await paidOn(tx, input.locationId, doc.id));
    assertPayment(input.amount, owed);

    const session = input.paidFrom === "cash" ? await requireOpenSession(tx, input.locationId, "Abre la caja para pagarle al proveedor de la caja", input.now) : null;
    const day = await requireOpenDay(tx, input.locationId, input.now ?? new Date(), (m) => new InventoryError(m));
    if (session && input.amount.minor > (await ledgerCash(tx, input.locationId))) throw cashShortError(input.actor);

    const memo = `Pago a ${doc.supplierName} (compra ${doc.id})`.slice(0, 300);
    const posted = await postEntry(tx, {
      locationId: input.locationId,
      createdBy: input.actor.userId,
      entry: supplierPaymentEntry(
        { amount: input.amount, paidFrom: input.paidFrom },
        { businessDate: day, memo, idempotencyKey: `supplier_payment:${input.idempotencyKey}` },
      ),
    });
    const [payment] = await tx
      .insert(supplierPayments)
      .values({
        locationId: input.locationId,
        documentId: doc.id,
        amount: input.amount.minor,
        paidFrom: input.paidFrom,
        businessDate: day,
        journalEntryId: posted.entryId,
        cashSessionId: session?.id ?? null,
        createdBy: input.actor.userId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      })
      .returning({ id: supplierPayments.id });
    if (session) {
      await tx.insert(cashMovements).values({
        locationId: input.locationId,
        cashSessionId: session.id,
        kind: "supplier_payment",
        journalEntryId: posted.entryId,
        description: memo.slice(0, 200),
        createdBy: input.actor.userId,
      });
    }
    const remaining = money(owed.minor - input.amount.minor);
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "inventory.supplier_payment",
      targetKind: "supplier_payment",
      targetRef: payment!.id.toString(),
      summary: `Pagó ${format(input.amount)} a ${doc.supplierName} ${SUPPLIER_PAID_FROM_LABELS[input.paidFrom]}; de esa compra se debe ${format(remaining)}`,
    });
    return { paymentId: payment!.id, amount: input.amount, remaining, supplierName: doc.supplierName, created: true };
  });
}

// ─── Anular un pago ──────────────────────────────────────────────────────────

/** Por qué un pago no se puede anular, o null si se puede (lo mismo que exige 0036). */
export type PaymentLock = "reversed" | "session_closed" | null;

export const PAYMENT_LOCK_MESSAGES: Record<Exclude<PaymentLock, null>, string> = {
  reversed: "Este pago ya está anulado",
  session_closed: "Este pago salió de un turno de caja que ya se cerró: no se puede anular (el arqueo de ese turno ya lo tuvo en cuenta).",
};

export interface ReverseSupplierPaymentInput {
  locationId: bigint;
  paymentId: bigint;
  actor: ActorRef & { role: Role };
  now?: Date;
}

/**
 * Anula un pago mal registrado (solo el dueño, inventory.manage): asienta la reversa exacta en el día
 * contable de hoy y la deuda vuelve. El de caja devuelve el efectivo a SU turno, que debe seguir
 * abierto. Repetir sobre un pago anulado devuelve created: false.
 */
export function reverseSupplierPayment(
  db: Db,
  input: ReverseSupplierPaymentInput,
): Promise<{ amount: Money; paidFrom: SupplierPaidFrom; created: boolean }> {
  return serializable(db, async (tx) => {
    if (!can(input.actor.role, "inventory.manage")) throw new InventoryError("Solo el dueño anula pagos a proveedores");
    await lockInventory(tx, input.locationId);
    const [p] = await tx
      .select({
        id: supplierPayments.id,
        amount: supplierPayments.amount,
        paidFrom: supplierPayments.paidFrom,
        entryId: supplierPayments.journalEntryId,
        sessionId: supplierPayments.cashSessionId,
      })
      .from(supplierPayments)
      .where(and(eq(supplierPayments.locationId, input.locationId), eq(supplierPayments.id, input.paymentId)));
    if (!p) throw new InventoryError("El pago no existe en esta sede");
    const amount = money(p.amount);
    const [reversed] = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.locationId, input.locationId), eq(journalEntries.reversesEntryId, p.entryId)));
    if (reversed) return { amount, paidFrom: p.paidFrom, created: false };

    const session = p.paidFrom === "cash" ? await requireOpenSession(tx, input.locationId, PAYMENT_LOCK_MESSAGES.session_closed, input.now) : null;
    if (session && session.id !== p.sessionId) throw new InventoryError(PAYMENT_LOCK_MESSAGES.session_closed);
    const day = await requireOpenDay(tx, input.locationId, input.now ?? new Date(), (m) => new InventoryError(m));

    const reversal = await reverseEntry(tx, {
      locationId: input.locationId,
      entryId: p.entryId,
      businessDate: day,
      reason: `Anulación del pago a proveedor ${p.id}`,
      createdBy: input.actor.userId,
    });
    if (session) {
      await tx.insert(cashMovements).values({
        locationId: input.locationId,
        cashSessionId: session.id,
        kind: "reversal",
        journalEntryId: reversal.entryId,
        description: "Anulación de un pago a proveedor",
        createdBy: input.actor.userId,
      });
    }
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "inventory.supplier_payment_reverse",
      targetKind: "supplier_payment",
      targetRef: p.id.toString(),
      summary: `Anuló un pago a proveedor de ${format(amount)}, hecho ${SUPPLIER_PAID_FROM_LABELS[p.paidFrom]}`,
    });
    return { amount, paidFrom: p.paidFrom, created: true };
  });
}

// ─── Lecturas ────────────────────────────────────────────────────────────────

export interface PayablePayment {
  id: bigint;
  businessDate: string;
  amount: Money;
  paidFrom: SupplierPaidFrom;
  lock: PaymentLock;
}

export interface Payable {
  documentId: bigint;
  supplierName: string;
  businessDate: string;
  dueDate: string;
  total: Money;
  /** Pagos vigentes (sumados en SQL). */
  paid: Money;
  outstanding: Money;
  /** "Cera para peinar (6 u.) y 1 más" */
  summary: string;
  due: DueStatus;
  /** Más nuevos primero (los anulados también, marcados). */
  payments: PayablePayment[];
}

export interface PayablesView {
  /** Día contable de hoy en la sede: desde ahí se miden los vencimientos. */
  today: string;
  /** Lo que se le debe a los proveedores según el libro (saldo de 2205). */
  balance: Money;
  /** Lo pendiente (del que vence primero al último) y luego lo pagado en los últimos 30 días. */
  rows: Payable[];
}

/** Para la vista de la deuda: lo pendiente y lo que se terminó de pagar hace poco (para anular un pago). */
export async function payables(db: Db, locationId: bigint, now: Date = new Date()): Promise<PayablesView> {
  const { businessDate: day } = await today(db, locationId, now);
  const docs = rowsOf<{
    id: string;
    supplier_name: string;
    business_date: string;
    due_date: string;
    total: string;
    paid: string;
    first_name: string;
    first_qty: number;
    lines: number;
  }>(
    await db.execute(sql`
      with docs as (
        select d.id, d.location_id, d.business_date, d.due_date, d.total, s.name as supplier_name,
               coalesce((select sum(p.amount) from supplier_payments p
                          where p.location_id = d.location_id and p.document_id = d.id
                            and not exists (select 1 from journal_entries r where r.location_id = p.location_id and r.reverses_entry_id = p.journal_entry_id)), 0) as paid,
               (select max(p.created_at) from supplier_payments p where p.location_id = d.location_id and p.document_id = d.id) as last_payment
          from inventory_documents d
          join suppliers s on s.location_id = d.location_id and s.id = d.supplier_id
         where d.location_id = ${locationId}::bigint and d.kind = 'purchase' and d.paid_from = 'credit'
           and not exists (select 1 from journal_entries r where r.location_id = d.location_id and r.reverses_entry_id = d.journal_entry_id)
      )
      select d.id::text, d.supplier_name, d.business_date::text, d.due_date::text, d.total::text, d.paid::text,
             f.name as first_name, f.quantity as first_qty,
             (select count(*)::int from inventory_document_lines l where l.location_id = d.location_id and l.document_id = d.id) as lines
        from docs d
        cross join lateral (
          select p.name, l.quantity from inventory_document_lines l
            join products p on p.location_id = l.location_id and p.id = l.product_id
           where l.location_id = d.location_id and l.document_id = d.id
           order by p.name limit 1
        ) f
       where d.paid < d.total or d.last_payment > now() - interval '30 days'
       order by (d.paid >= d.total), d.due_date, d.id
    `),
  );
  const ids = docs.map((d) => BigInt(d.id));
  const payments =
    ids.length === 0
      ? []
      : rowsOf<{ id: string; document_id: string; business_date: string; amount: string; paid_from: SupplierPaidFrom; reversed: boolean; session_closed: boolean | null }>(
          await db.execute(sql`
            select p.id::text, p.document_id::text, p.business_date::text, p.amount::text, p.paid_from,
                   exists (select 1 from journal_entries r where r.location_id = p.location_id and r.reverses_entry_id = p.journal_entry_id) as reversed,
                   (select s.closed_at is not null from cash_sessions s where s.location_id = p.location_id and s.id = p.cash_session_id) as session_closed
              from supplier_payments p
             where p.location_id = ${locationId}::bigint and p.document_id in (${sql.join(
               ids.map((id) => sql`${id}::bigint`),
               sql`, `,
             )})
             order by p.id desc
          `),
        );
  const byDoc = new Map<string, PayablePayment[]>();
  for (const p of payments) {
    const list = byDoc.get(p.document_id) ?? [];
    list.push({
      id: BigInt(p.id),
      businessDate: p.business_date,
      amount: money(BigInt(p.amount)),
      paidFrom: p.paid_from,
      lock: p.reversed ? "reversed" : p.paid_from === "cash" && p.session_closed !== false ? "session_closed" : null,
    });
    byDoc.set(p.document_id, list);
  }
  const balance = await accountBalance(db, locationId, ACCOUNTS.accountsPayable.code);
  return {
    today: day,
    // 2205 es pasivo: su saldo natural es crédito (débitos − créditos < 0).
    balance: money(-balance),
    rows: docs.map((d) => {
      const total = money(BigInt(d.total));
      const paid = money(BigInt(d.paid));
      return {
        documentId: BigInt(d.id),
        supplierName: d.supplier_name,
        businessDate: d.business_date,
        dueDate: d.due_date,
        total,
        paid,
        outstanding: outstanding(total, paid),
        summary: d.lines > 1 ? `${d.first_name} (${d.first_qty} u.) y ${d.lines - 1} más` : `${d.first_name} (${d.first_qty} u.)`,
        due: dueStatus(d.due_date, day),
        payments: byDoc.get(d.id) ?? [],
      };
    }),
  };
}

/** Nombres de los proveedores de la sede (para sugerirlos en la compra a crédito), en orden alfabético. */
export async function supplierNames(db: Db, locationId: bigint): Promise<string[]> {
  const rows = rowsOf<{ name: string }>(
    await db.execute(sql`select name from suppliers where location_id = ${locationId}::bigint order by lower(name) limit 200`),
  );
  return rows.map((r) => r.name);
}

/**
 * Lo que vence pronto: compras a crédito con saldo, vencidas o que vencen en DUE_SOON_DAYS días o
 * menos (día contable de la sede). Para la alerta de Inicio. El saldo se suma en SQL.
 */
export async function payablesDue(db: Db, locationId: bigint, now: Date = new Date()): Promise<{ count: number; total: Money; overdue: number }> {
  const { businessDate: day } = await today(db, locationId, now);
  const [row] = rowsOf<{ count: number; total: string; overdue: number }>(
    await db.execute(sql`
      with pending as (
        select d.due_date,
               d.total - coalesce((select sum(p.amount) from supplier_payments p
                                    where p.location_id = d.location_id and p.document_id = d.id
                                      and not exists (select 1 from journal_entries r where r.location_id = p.location_id and r.reverses_entry_id = p.journal_entry_id)), 0) as owed
          from inventory_documents d
         where d.location_id = ${locationId}::bigint and d.kind = 'purchase' and d.paid_from = 'credit'
           and not exists (select 1 from journal_entries r where r.location_id = d.location_id and r.reverses_entry_id = d.journal_entry_id)
      )
      select count(*)::int as count, coalesce(sum(owed), 0)::text as total,
             count(*) filter (where due_date < ${day}::date)::int as overdue
        from pending
       where owed > 0 and due_date <= ${day}::date + ${DUE_SOON_DAYS}::int
    `),
  );
  return { count: row?.count ?? 0, total: money(BigInt(row?.total ?? "0")), overdue: row?.overdue ?? 0 };
}
