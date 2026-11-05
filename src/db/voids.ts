import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { receiptNumberLabel } from "@/domain/commissions/settlement";
import { format, money } from "@/domain/money";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import { assertCanApproveVoid, requireReason, VoidError } from "@/domain/sales/void";
import type { Role } from "@/domain/staff/roles";
import { recordAudit } from "./audit";
import { ledgerCash, requireOpenSession, tipsOwed } from "./cash";
import { isDayClosed, reverseEntry } from "./ledger";
import {
  cashMovements,
  commissionSettlementLines,
  commissionSettlements,
  saleLines,
  salePayments,
  sales,
  saleTips,
  staffMembers,
  voidRequests,
} from "./schema";
import { serializable } from "./serializable";
import { sumAsBigint } from "./sql";
import type { Db } from "./types";

// Anulaciones (docs/sprint-4-cobro-caja.md §3 y §6). Recepción solicita (ledger.post); el dueño
// aprueba o rechaza (ledger.reverse + reautenticación, en la acción). Aprobar registra la reversa
// exacta del asiento de la venta en su mismo día contable y marca la venta anulada, en una sola
// transacción SERIALIZABLE.

export async function requestVoid(
  db: Db,
  input: { locationId: bigint; saleId: bigint; reason: string; idempotencyKey: string; actor: { userId: string } },
): Promise<{ requestId: bigint; created: boolean }> {
  const reason = requireReason(input.reason, "el motivo de la anulación");
  const hash = requestHash({ kind: "void_request", locationId: input.locationId, saleId: input.saleId, reason, by: input.actor.userId });
  return serializable(db, async (tx) => {
    const [existing] = await tx
      .select({ id: voidRequests.id, requestHash: voidRequests.requestHash })
      .from(voidRequests)
      .where(and(eq(voidRequests.locationId, input.locationId), eq(voidRequests.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      assertSameRequest(existing, hash);
      return { requestId: existing.id, created: false };
    }
    const [sale] = await tx
      .select({ status: sales.status })
      .from(sales)
      .where(and(eq(sales.locationId, input.locationId), eq(sales.id, input.saleId)));
    if (!sale) throw new VoidError("La venta no existe");
    if (sale.status !== "paid") throw new VoidError("Esta venta ya está anulada");
    const [pending] = await tx
      .select({ id: voidRequests.id })
      .from(voidRequests)
      .where(and(eq(voidRequests.saleId, input.saleId), eq(voidRequests.status, "pending")));
    if (pending) throw new VoidError("Ya hay una solicitud de anulación pendiente para esta venta");
    const [row] = await tx
      .insert(voidRequests)
      .values({
        locationId: input.locationId,
        saleId: input.saleId,
        requestedBy: input.actor.userId,
        reason,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      })
      .returning({ id: voidRequests.id });
    // El motivo es texto libre y puede nombrar al cliente: no entra a la bitácora.
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      action: "void.request",
      targetKind: "void_request",
      targetRef: row!.id.toString(),
      summary: "Pidió anular una venta",
    });
    return { requestId: row!.id, created: true };
  });
}

export interface VoidDecision {
  status: "approved" | "rejected";
  /** Aviso para el dueño (propinas de la venta ya pagadas en efectivo) o null. */
  warning: string | null;
  created: boolean;
}

/** Personas cuyas propinas de esta venta ya se pagaron: tras anular, quedan debiendo (SQL). */
async function paidOutTipsWarning(db: Db, locationId: bigint, saleId: bigint): Promise<string | null> {
  const tipStaff = await db
    .select({ staffId: saleTips.staffId })
    .from(saleTips)
    .where(and(eq(saleTips.locationId, locationId), eq(saleTips.saleId, saleId)));
  if (tipStaff.length === 0) return null;
  const ids = new Set(tipStaff.map((t) => t.staffId));
  const negative = (await tipsOwed(db, locationId)).filter((t) => ids.has(t.staffId) && t.owed < 0n);
  if (negative.length === 0) return null;
  return `Las propinas de esta venta ya se pagaron en efectivo a ${negative.map((n) => n.name).join(", ")}. La anulación no las devuelve en efectivo: se le descuentan en su próxima liquidación.`;
}

/**
 * Comisiones de esta venta ya pagadas en una liquidación vigente (§3.4): la N.º pagada no se toca y
 * se descuenta en la próxima liquidación de la persona.
 */
async function settledCommissionWarnings(db: Db, locationId: bigint, saleId: bigint): Promise<string[]> {
  const rows = await db
    .select({
      name: staffMembers.displayName,
      number: commissionSettlements.number,
      // En una repetición de la aprobación el descuento pudo aplicarse ya: se dice dónde.
      clawbackNumber: sql<string | null>`(
        select max(cb_st.number)::text
          from commission_settlement_lines cb
          join commission_settlements cb_st on cb_st.location_id = cb.location_id and cb_st.id = cb.settlement_id
         where cb.location_id = ${saleLines.locationId} and cb.sale_line_id = ${saleLines.id}
           and cb.kind = 'clawback' and not cb.reversed
      )`,
    })
    .from(saleLines)
    .innerJoin(
      commissionSettlementLines,
      and(
        eq(commissionSettlementLines.locationId, saleLines.locationId),
        eq(commissionSettlementLines.saleLineId, saleLines.id),
        eq(commissionSettlementLines.kind, "commission"),
        eq(commissionSettlementLines.reversed, false),
      ),
    )
    .innerJoin(
      commissionSettlements,
      and(eq(commissionSettlements.locationId, commissionSettlementLines.locationId), eq(commissionSettlements.id, commissionSettlementLines.settlementId)),
    )
    .innerJoin(staffMembers, and(eq(staffMembers.locationId, saleLines.locationId), eq(staffMembers.id, saleLines.staffId)))
    .where(and(eq(saleLines.locationId, locationId), eq(saleLines.saleId, saleId)))
    .orderBy(asc(commissionSettlements.number), asc(staffMembers.displayName));
  const messages = rows.map((r) => {
    const paid = `La comisión de esta venta ya se le pagó a ${r.name} en la liquidación ${receiptNumberLabel(r.number)}.`;
    return r.clawbackNumber === null
      ? `${paid} Se le descontará en su próxima liquidación.`
      : `${paid} Ya se le descontó en la liquidación ${receiptNumberLabel(BigInt(r.clawbackNumber))}.`;
  });
  return [...new Set(messages)];
}

/** Todos los avisos de una anulación aprobada, uno por línea; null si no hay. */
async function voidWarning(db: Db, locationId: bigint, saleId: bigint): Promise<string | null> {
  const tips = await paidOutTipsWarning(db, locationId, saleId);
  const parts = [...(tips ? [tips] : []), ...(await settledCommissionWarnings(db, locationId, saleId))];
  return parts.length > 0 ? parts.join("\n") : null;
}

export async function decideVoid(
  db: Db,
  input: {
    locationId: bigint;
    requestId: bigint;
    approve: boolean;
    note: string;
    idempotencyKey: string;
    approver: { userId: string; role: Role };
    now?: Date;
  },
): Promise<VoidDecision> {
  // Rechazar exige explicar por qué; aprobar usa el motivo de la solicitud (la nota es opcional).
  const note = input.approve ? input.note.trim() || null : requireReason(input.note, "el motivo del rechazo");
  if (note && note.length > 300) throw new VoidError("La nota es muy larga");
  const hash = requestHash({
    kind: "void_decision",
    locationId: input.locationId,
    requestId: input.requestId,
    approve: input.approve,
    note,
    by: input.approver.userId,
  });
  return serializable(db, async (tx) => {
    const [req] = await tx
      .select({
        id: voidRequests.id,
        saleId: voidRequests.saleId,
        reason: voidRequests.reason,
        status: voidRequests.status,
        decisionKey: voidRequests.decisionIdempotencyKey,
        decisionHash: voidRequests.decisionRequestHash,
      })
      .from(voidRequests)
      .where(and(eq(voidRequests.locationId, input.locationId), eq(voidRequests.id, input.requestId)))
      .for("update");
    if (!req) throw new VoidError("La solicitud no existe");
    if (req.status !== "pending") {
      if (req.decisionKey !== input.idempotencyKey) throw new VoidError("Esta solicitud ya se decidió");
      assertSameRequest({ requestHash: req.decisionHash }, hash);
      const warning = req.status === "approved" ? await voidWarning(tx, input.locationId, req.saleId) : null;
      return { status: req.status, warning, created: false };
    }
    // Las horas las pone la base (0011: el trigger las fuerza a now()).
    const decided = {
      decidedBy: input.approver.userId,
      decidedAt: sql`now()`,
      decisionNote: note,
      decisionIdempotencyKey: input.idempotencyKey,
      decisionRequestHash: hash,
    };

    if (!input.approve) {
      await tx.update(voidRequests).set({ status: "rejected", ...decided }).where(eq(voidRequests.id, req.id));
      await recordAudit(tx, {
        locationId: input.locationId,
        actorUserId: input.approver.userId,
        action: "void.reject",
        targetKind: "void_request",
        targetRef: req.id.toString(),
        summary: "Rechazó la anulación de una venta",
      });
      return { status: "rejected", warning: null, created: true };
    }

    const [sale] = await tx
      .select({ id: sales.id, publicId: sales.publicId, status: sales.status, createdBy: sales.createdBy, businessDate: sales.businessDate, journalEntryId: sales.journalEntryId })
      .from(sales)
      .where(and(eq(sales.locationId, input.locationId), eq(sales.id, req.saleId)))
      .for("update");
    if (!sale) throw new VoidError("La venta no existe");
    if (sale.status !== "paid") throw new VoidError("Esta venta ya está anulada");
    assertCanApproveVoid({ approverUserId: input.approver.userId, approverRole: input.approver.role, chargedBy: sale.createdBy });
    // La reversa va en el mismo día contable de la venta [alternativa a confirmar: el día actual].
    if (await isDayClosed(tx, input.locationId, sale.businessDate)) {
      throw new VoidError(`El día ${sale.businessDate} de esta venta ya está cerrado. Reábrelo primero y vuelve a aprobar la anulación.`);
    }

    const [cash] = await tx
      .select({ total: sumAsBigint(salePayments.amount) })
      .from(salePayments)
      .where(and(eq(salePayments.locationId, input.locationId), eq(salePayments.saleId, sale.id), eq(salePayments.kind, "cash")));
    const cashInSale = cash?.total ?? 0n;
    // Devolver efectivo exige la caja ABIERTA (bloqueada FOR UPDATE): la devolución es un movimiento
    // del turno, sale de lo que hay y nunca deja el libro de caja negativo. Con la caja cerrada, la
    // devolución bajaba 1105 por debajo de cero y la apertura siguiente inventaba un sobrante en 5310
    // (C1). La base también lo exige al hacer COMMIT (0011: 1105 >= 0).
    const session =
      cashInSale > 0n ? await requireOpenSession(tx, input.locationId, "Abre la caja para devolver el efectivo de esta venta", input.now) : undefined;
    if (session && cashInSale > (await ledgerCash(tx, input.locationId))) {
      throw new VoidError(
        `En la caja no hay ${format(money(cashInSale))} para devolver esta venta en efectivo. La devolución sale de la caja: espera a tener ese efectivo en el turno.`,
      );
    }

    const reversal = await reverseEntry(tx, {
      locationId: input.locationId,
      entryId: sale.journalEntryId,
      businessDate: sale.businessDate,
      // El memo del libro es inmutable: no lleva el motivo, que es texto libre y puede traer datos del
      // cliente. El motivo queda en la solicitud, donde la supresión lo puede borrar.
      reason: `Anulación de la venta ${sale.publicId}`,
      createdBy: input.approver.userId,
    });
    await tx
      .update(sales)
      .set({ status: "voided", voidEntryId: reversal.entryId, voidedAt: sql`now()` })
      .where(and(eq(sales.id, sale.id), eq(sales.status, "paid")));
    if (session) {
      await tx.insert(cashMovements).values({
        locationId: input.locationId,
        cashSessionId: session.id,
        kind: "reversal",
        journalEntryId: reversal.entryId,
        description: `Anulación: ${req.reason}`.slice(0, 200),
        createdBy: input.approver.userId,
      });
    }
    await tx.update(voidRequests).set({ status: "approved", ...decided }).where(eq(voidRequests.id, req.id));

    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.approver.userId,
      action: "void.approve",
      targetKind: "void_request",
      targetRef: req.id.toString(),
      summary: `Aprobó la anulación de una venta del ${sale.businessDate}`,
    });
    const warning = await voidWarning(tx, input.locationId, sale.id);
    return { status: "approved", warning, created: true };
  });
}

export interface VoidQueueRow {
  id: bigint;
  saleId: bigint;
  createdAt: Date;
  requestedBy: string | null;
  chargedBy: string | null;
  reason: string;
  totalPaid: bigint;
  status: "pending" | "approved" | "rejected";
  lines: { description: string; net: bigint }[];
}

/** Cola de anulaciones de la sede: pendientes primero. `requestedBy`: solo las de esa persona. */
export async function voidQueue(db: Db, input: { locationId: bigint; requestedBy?: string; limit?: number }): Promise<VoidQueueRow[]> {
  // Nombres en la sede (staff_members), no los de la cuenta: esos los controla cada quien.
  const requester = alias(staffMembers, "requester");
  const charger = alias(staffMembers, "charger");
  const rows = await db
    .select({
      id: voidRequests.id,
      saleId: voidRequests.saleId,
      createdAt: voidRequests.createdAt,
      requestedBy: requester.displayName,
      chargedBy: charger.displayName,
      reason: voidRequests.reason,
      totalPaid: sales.totalPaid,
      status: voidRequests.status,
    })
    .from(voidRequests)
    .innerJoin(sales, and(eq(sales.locationId, voidRequests.locationId), eq(sales.id, voidRequests.saleId)))
    .leftJoin(requester, and(eq(requester.locationId, voidRequests.locationId), eq(requester.userId, voidRequests.requestedBy)))
    .leftJoin(charger, and(eq(charger.locationId, sales.locationId), eq(charger.userId, sales.createdBy)))
    .where(
      and(
        eq(voidRequests.locationId, input.locationId),
        input.requestedBy === undefined ? undefined : eq(voidRequests.requestedBy, input.requestedBy),
      ),
    )
    .orderBy(sql`${voidRequests.status} <> 'pending'`, desc(voidRequests.id))
    .limit(input.limit ?? 100);
  if (rows.length === 0) return [];
  const lines = await db
    .select({ saleId: saleLines.saleId, description: saleLines.description, net: saleLines.net })
    .from(saleLines)
    .where(and(eq(saleLines.locationId, input.locationId), inArray(saleLines.saleId, [...new Set(rows.map((r) => r.saleId))])))
    .orderBy(asc(saleLines.saleId), asc(saleLines.position));
  return rows.map((r) => ({
    ...r,
    lines: lines.filter((l) => l.saleId === r.saleId).map((l) => ({ description: l.description, net: l.net })),
  }));
}
