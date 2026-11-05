import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import {
  type AdjustmentInput,
  assertCutoff,
  assertReversible,
  computeSettlement,
  type PaidFrom,
  receiptNumberLabel,
  requireSettlementReason,
  SettlementError,
  type SettlementDraft,
  settledTips,
  settlementEntry,
  staffAdvanceEntry,
} from "@/domain/commissions/settlement";
import { format, type Money, money } from "@/domain/money";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import { recordAudit } from "./audit";
import { type ActorRef, cashShortError, ledgerCash, lockStaff, requireOpenDay, requireOpenSession, sessionOpenOn, today } from "./cash";
import { postEntry, reverseEntry } from "./ledger";
import { cashMovements, commissionSettlementLines, commissionSettlements, locations, staffAdvances, staffMembers } from "./schema";
import { serializable } from "./serializable";
import { rowsOf } from "./sql";
import type { Db } from "./types";
import { ulid } from "./ulid";

export { lockStaff };

// Liquidación de comisiones y anticipos (docs/sprint-5-comisiones-informes.md §4, §5 y §12.2). El
// servidor lee todo de la base y calcula con computeSettlement. Cada escritura corre en una
// transacción SERIALIZABLE, con su clave de idempotencia ligada al contenido, y toma primero la
// fila de la persona: todo lo que mueve sus saldos va en fila. Los totales los vuelve a exigir la
// base al hacer COMMIT (migración 0013).

const LINE_INSERT_CHUNK = 2_000;

export interface SettlementOptions {
  locationId: bigint;
  staffId: bigint;
  cutoffDate: string;
  includeTips: boolean;
  advanceDeduction: Money | "max";
  adjustments: AdjustmentInput[];
  paidFrom: PaidFrom;
  note: string | null;
  now?: Date;
}

export interface StaffBalances {
  staffId: bigint;
  name: string;
  active: boolean;
  /** staff_commission_owed: negativo si ya se pagó una comisión que se anuló. */
  commissionOwed: bigint;
  tipsOwed: bigint;
  receivable: bigint;
  /** Lo que se puede liquidar: sin las líneas que esperan una decisión de anulación. */
  pendingCommission: bigint;
  pendingLines: number;
  waitingVoidDecision: number;
  clawbacks: bigint;
  lastSettlement: { publicId: string; number: bigint; cutoffDate: string; payout: bigint } | null;
}

export interface PendingCommissionRow {
  saleLineId: bigint;
  businessDate: string;
  description: string;
  net: bigint;
  commissionBps: number;
  commission: bigint;
}

export interface PendingClawbackRow {
  saleLineId: bigint;
  businessDate: string;
  description: string;
  commission: bigint;
  /** La liquidación que pagó esa comisión. */
  settlementNumber: bigint;
}

export interface SettlementPreviewData {
  staff: { id: bigint; name: string };
  cutoffDate: string;
  periodFromDate: string | null;
  businessDate: string;
  dayClosed: boolean;
  commissions: PendingCommissionRow[];
  clawbacks: PendingClawbackRow[];
  waitingVoidDecision: number;
  tipsOwed: bigint;
  receivable: bigint;
  /** min(lo que debe, max(G, 0)). */
  maxDeduction: bigint;
  draft: SettlementDraft;
  adjustments: AdjustmentInput[];
  tipsIncluded: boolean;
  /** Se debe devolver al menos un peso de propinas: se recupera aunque se desmarque la casilla. */
  tipsMandatory: boolean;
  cash: { sessionOpen: boolean; enough: boolean };
  previewToken: string;
}

interface SettlementHistoryRow {
  publicId: string;
  number: bigint;
  businessDate: string;
  cutoffDate: string;
  payout: bigint;
  paidFrom: PaidFrom | null;
  status: "settled" | "reversed";
  canReverse: boolean;
}

interface AdvanceHistoryRow {
  publicId: string;
  number: bigint;
  businessDate: string;
  amount: bigint;
  reason: string;
  paidFrom: PaidFrom;
  status: "active" | "reversed";
  canReverse: boolean;
}

export interface StaffCommissionDetail {
  staff: { id: bigint; name: string; active: boolean };
  businessDate: string;
  dayClosed: boolean;
  cashSessionOpen: boolean;
  lastCutoffDate: string | null;
  settlements: SettlementHistoryRow[];
  advances: AdvanceHistoryRow[];
}

export type ReceiptData =
  | ({ kind: "settlement" } & SettlementReceipt & ReceiptCommon)
  | ({ kind: "advance" } & AdvanceReceipt & ReceiptCommon);

interface ReceiptCommon {
  publicId: string;
  number: bigint;
  /** Para el control de acceso: de quién es el comprobante. */
  staffId: bigint;
  staffName: string;
  locationName: string;
  timeZone: string;
  businessDate: string;
  createdAt: Date;
  createdBy: string;
  reversal: { at: Date; by: string; reason: string } | null;
}

interface SettlementReceipt {
  status: "settled" | "reversed";
  paidFrom: PaidFrom | null;
  periodFrom: string;
  cutoffDate: string;
  commissions: { businessDate: string; description: string; net: bigint; commissionBps: number; commission: bigint }[];
  clawbacks: { businessDate: string; description: string; amount: bigint; settlementNumber: bigint | null }[];
  tips: bigint;
  adjustments: { amount: bigint; reason: string }[];
  advanceDeduction: bigint;
  carryOver: bigint;
  commissionTotal: bigint;
  clawbackTotal: bigint;
  adjustmentsTotal: bigint;
  payout: bigint;
  note: string | null;
}

interface AdvanceReceipt {
  status: "active" | "reversed";
  paidFrom: PaidFrom;
  amount: bigint;
  reason: string;
}

const big = (v: string | null | undefined): bigint => BigInt(v ?? "0");

// ─── Lo pendiente: UNA definición, igual que los triggers de 0013 ────────────

/** Líneas con comisión, en ventas pagadas, sin reclamo vigente y sin anulación pendiente. */
export async function pendingCommissions(db: Db, input: { locationId: bigint; staffId: bigint; cutoffDate: string; limit?: number }): Promise<PendingCommissionRow[]> {
  const rows = rowsOf<{ id: string; business_date: string; description: string; net: string; commission_bps: number; commission: string }>(
    await db.execute(sql`
      select l.id::text as id, s.business_date::text as business_date, l.description, l.net::text as net,
             l.commission_bps, l.commission::text as commission
        from sale_lines l
        join sales s on s.location_id = l.location_id and s.id = l.sale_id
       where l.location_id = ${input.locationId}::bigint and l.staff_id = ${input.staffId}::bigint
         and l.commission > 0 and s.status = 'paid' and s.business_date <= ${input.cutoffDate}::date
         and not exists (select 1 from void_requests vr
                          where vr.location_id = s.location_id and vr.sale_id = s.id and vr.status = 'pending')
         and not exists (select 1 from commission_settlement_lines c
                          where c.location_id = l.location_id and c.sale_line_id = l.id and c.kind = 'commission' and not c.reversed)
       order by s.business_date, l.id
       ${input.limit === undefined ? sql`` : sql`limit ${input.limit}`}
    `),
  );
  return rows.map((r) => ({
    saleLineId: BigInt(r.id),
    businessDate: r.business_date,
    description: r.description,
    net: BigInt(r.net),
    commissionBps: Number(r.commission_bps),
    commission: BigInt(r.commission),
  }));
}

/** Líneas de ventas anuladas ya pagadas y aún sin descontar. Todas: son deudas ya causadas. */
export async function pendingClawbacks(db: Db, input: { locationId: bigint; staffId: bigint }): Promise<PendingClawbackRow[]> {
  const rows = rowsOf<{ id: string; business_date: string; description: string; commission: string; settlement_number: string }>(
    await db.execute(sql`
      select l.id::text as id, s.business_date::text as business_date, l.description, l.commission::text as commission,
             st.number::text as settlement_number
        from sale_lines l
        join sales s on s.location_id = l.location_id and s.id = l.sale_id
        join commission_settlement_lines c
          on c.location_id = l.location_id and c.sale_line_id = l.id and c.kind = 'commission' and not c.reversed
        join commission_settlements st on st.location_id = c.location_id and st.id = c.settlement_id
       where l.location_id = ${input.locationId}::bigint and l.staff_id = ${input.staffId}::bigint and s.status = 'voided'
         and not exists (select 1 from commission_settlement_lines v
                          where v.location_id = l.location_id and v.sale_line_id = l.id and v.kind = 'clawback' and not v.reversed)
       order by s.business_date, l.id
    `),
  );
  return rows.map((r) => ({
    saleLineId: BigInt(r.id),
    businessDate: r.business_date,
    description: r.description,
    commission: BigInt(r.commission),
    settlementNumber: BigInt(r.settlement_number),
  }));
}

async function waitingVoidDecisions(db: Db, input: { locationId: bigint; staffId: bigint; cutoffDate: string }): Promise<number> {
  const [row] = rowsOf<{ n: string }>(
    await db.execute(sql`
      select count(*)::text as n
        from sale_lines l
        join sales s on s.location_id = l.location_id and s.id = l.sale_id
       where l.location_id = ${input.locationId}::bigint and l.staff_id = ${input.staffId}::bigint
         and l.commission > 0 and s.status = 'paid' and s.business_date <= ${input.cutoffDate}::date
         and exists (select 1 from void_requests vr where vr.location_id = s.location_id and vr.sale_id = s.id and vr.status = 'pending')
         and not exists (select 1 from commission_settlement_lines c
                          where c.location_id = l.location_id and c.sale_line_id = l.id and c.kind = 'commission' and not c.reversed)
    `),
  );
  return Number(row?.n ?? "0");
}

/** Saldos en UNA consulta SQL. Con `staffId`, solo esa persona; si no, toda la sede. */
export async function commissionBalances(db: Db, locationId: bigint, opts: { staffId?: bigint } = {}): Promise<StaffBalances[]> {
  const rows = rowsOf<{
    staff_id: string;
    name: string;
    active: boolean;
    commission_owed: string;
    tips_owed: string;
    receivable: string;
    pending_commission: string;
    pending_lines: string;
    waiting: string;
    clawbacks: string;
    last_public_id: string | null;
    last_number: string | null;
    last_cutoff: string | null;
    last_payout: string | null;
  }>(
    await db.execute(sql`
      select m.id::text as staff_id, m.display_name as name, m.active,
             staff_commission_owed(m.location_id, m.id)::text as commission_owed,
             staff_tips_owed(m.location_id, m.id)::text as tips_owed,
             staff_receivable(m.location_id, m.id)::text as receivable,
             p.total::text as pending_commission, p.lines::text as pending_lines, p.waiting::text as waiting,
             v.total::text as clawbacks,
             last.public_id as last_public_id, last.number::text as last_number,
             last.cutoff_date::text as last_cutoff, last.payout::text as last_payout
        from staff_members m
        cross join lateral (
          select coalesce(sum(l.commission) filter (where vr.sale_id is null), 0) as total,
                 count(*) filter (where vr.sale_id is null) as lines,
                 count(*) filter (where vr.sale_id is not null) as waiting
            from sale_lines l
            join sales s on s.location_id = l.location_id and s.id = l.sale_id
            left join void_requests vr on vr.location_id = s.location_id and vr.sale_id = s.id and vr.status = 'pending'
           where l.location_id = m.location_id and l.staff_id = m.id and l.commission > 0 and s.status = 'paid'
             and not exists (select 1 from commission_settlement_lines c
                              where c.location_id = l.location_id and c.sale_line_id = l.id and c.kind = 'commission' and not c.reversed)
        ) p
        cross join lateral (
          select coalesce(sum(l.commission), 0) as total
            from sale_lines l
            join sales s on s.location_id = l.location_id and s.id = l.sale_id
           where l.location_id = m.location_id and l.staff_id = m.id and s.status = 'voided'
             and exists (select 1 from commission_settlement_lines c
                          where c.location_id = l.location_id and c.sale_line_id = l.id and c.kind = 'commission' and not c.reversed)
             and not exists (select 1 from commission_settlement_lines c
                              where c.location_id = l.location_id and c.sale_line_id = l.id and c.kind = 'clawback' and not c.reversed)
        ) v
        left join lateral (
          select st.public_id, st.number, st.cutoff_date, st.payout
            from commission_settlements st
           where st.location_id = m.location_id and st.staff_id = m.id and st.status = 'settled'
           order by st.number desc limit 1
        ) last on true
       where m.location_id = ${locationId}::bigint
         ${opts.staffId === undefined ? sql`` : sql`and m.id = ${opts.staffId}::bigint`}
       order by m.display_name, m.id
    `),
  );
  return rows.map((r) => ({
    staffId: BigInt(r.staff_id),
    name: r.name,
    active: r.active,
    commissionOwed: BigInt(r.commission_owed),
    tipsOwed: BigInt(r.tips_owed),
    receivable: BigInt(r.receivable),
    pendingCommission: BigInt(r.pending_commission),
    pendingLines: Number(r.pending_lines),
    waitingVoidDecision: Number(r.waiting),
    clawbacks: BigInt(r.clawbacks),
    lastSettlement:
      r.last_public_id === null ? null : { publicId: r.last_public_id, number: big(r.last_number), cutoffDate: r.last_cutoff!, payout: big(r.last_payout) },
  }));
}

/** Totales de la sede en SQL, para la cabecera de Comisiones. */
export async function commissionBalanceTotals(db: Db, locationId: bigint): Promise<{ commissionOwed: bigint; tipsOwed: bigint; receivable: bigint }> {
  const [row] = rowsOf<{ commission: string; tips: string; receivable: string }>(
    await db.execute(sql`
      select coalesce(sum(staff_commission_owed(m.location_id, m.id)), 0)::text as commission,
             coalesce(sum(staff_tips_owed(m.location_id, m.id)), 0)::text as tips,
             coalesce(sum(staff_receivable(m.location_id, m.id)), 0)::text as receivable
        from staff_members m where m.location_id = ${locationId}::bigint
    `),
  );
  return { commissionOwed: big(row?.commission), tipsOwed: big(row?.tips), receivable: big(row?.receivable) };
}

/** El corte de la última liquidación vigente de la persona. */
async function lastCutoff(db: Db, locationId: bigint, staffId: bigint): Promise<string | null> {
  const [row] = await db
    .select({ cutoff: commissionSettlements.cutoffDate })
    .from(commissionSettlements)
    .where(and(eq(commissionSettlements.locationId, locationId), eq(commissionSettlements.staffId, staffId), eq(commissionSettlements.status, "settled")))
    .orderBy(desc(commissionSettlements.number))
    .limit(1);
  return row?.cutoff ?? null;
}

// ─── Vista previa ────────────────────────────────────────────────────────────

/** Solo lectura y desde la base. El token resume exactamente lo que el dueño está viendo. */
export async function previewSettlement(db: Db, opts: SettlementOptions): Promise<SettlementPreviewData> {
  const [person] = await db
    .select({ name: staffMembers.displayName })
    .from(staffMembers)
    .where(and(eq(staffMembers.locationId, opts.locationId), eq(staffMembers.id, opts.staffId)));
  if (!person) throw new SettlementError("Esa persona no existe en la sede");
  const day = await today(db, opts.locationId, opts.now ?? new Date());
  assertCutoff({ cutoffDate: opts.cutoffDate, today: day.businessDate, lastCutoffDate: await lastCutoff(db, opts.locationId, opts.staffId) });

  const scope = { locationId: opts.locationId, staffId: opts.staffId };
  const commissions = await pendingCommissions(db, { ...scope, cutoffDate: opts.cutoffDate });
  const clawbacks = await pendingClawbacks(db, scope);
  const waitingVoidDecision = await waitingVoidDecisions(db, { ...scope, cutoffDate: opts.cutoffDate });
  const [balance] = await commissionBalances(db, opts.locationId, { staffId: opts.staffId });
  const tipsOwed = balance?.tipsOwed ?? 0n;
  const receivable = balance?.receivable ?? 0n;

  const draft = computeSettlement({
    commissions: commissions.map((c) => ({ saleLineId: c.saleLineId, businessDate: c.businessDate, commission: money(c.commission) })),
    clawbacks: clawbacks.map((c) => ({ saleLineId: c.saleLineId, businessDate: c.businessDate, commission: money(c.commission) })),
    tipsOwed: money(tipsOwed),
    includeTips: opts.includeTips,
    receivable: money(receivable),
    advanceDeduction: opts.advanceDeduction,
    adjustments: opts.adjustments,
  });
  const positiveGross = draft.gross.minor > 0n ? draft.gross.minor : 0n;
  const maxDeduction = receivable < positiveGross ? receivable : positiveGross;

  const session = await sessionOpenOn(db, opts.locationId, day.businessDate);
  const cash = await ledgerCash(db, opts.locationId);

  const previewToken = requestHash({
    kind: "settlement_preview",
    locationId: opts.locationId,
    staffId: opts.staffId,
    cutoffDate: opts.cutoffDate,
    includeTips: opts.includeTips,
    advanceDeduction: opts.advanceDeduction === "max" ? "max" : opts.advanceDeduction.minor,
    paidFrom: opts.paidFrom,
    tipsOwed,
    receivable,
    lines: draft.lines.map((l) => ({ kind: l.kind, saleLineId: l.saleLineId ?? null, amount: l.amount.minor, reason: l.reason ?? null })),
    payout: draft.payout.minor,
  });

  return {
    staff: { id: opts.staffId, name: person.name },
    cutoffDate: opts.cutoffDate,
    periodFromDate: commissions[0]?.businessDate ?? null,
    businessDate: day.businessDate,
    dayClosed: day.closed,
    commissions,
    clawbacks,
    waitingVoidDecision,
    tipsOwed,
    receivable,
    maxDeduction,
    draft,
    adjustments: opts.adjustments,
    tipsIncluded: opts.includeTips || draft.tips.minor < 0n,
    tipsMandatory: draft.tips.minor < 0n,
    cash: { sessionOpen: session, enough: draft.payout.minor <= cash },
    previewToken,
  };
}

// ─── Liquidar ────────────────────────────────────────────────────────────────

export async function settleCommissions(
  db: Db,
  cmd: SettlementOptions & { previewToken: string; idempotencyKey: string; actor: ActorRef },
): Promise<{ settlementId: bigint; publicId: string; number: bigint; payout: bigint; created: boolean }> {
  const note = cmd.note?.trim() || null;
  if (note && note.length > 300) throw new SettlementError("La nota es muy larga");
  const hash = requestHash({
    kind: "settlement",
    locationId: cmd.locationId,
    staffId: cmd.staffId,
    cutoffDate: cmd.cutoffDate,
    previewToken: cmd.previewToken,
    note,
    by: cmd.actor.userId,
  });
  return serializable(db, async (tx) => {
    const [existing] = await tx
      .select({
        id: commissionSettlements.id,
        publicId: commissionSettlements.publicId,
        number: commissionSettlements.number,
        payout: commissionSettlements.payout,
        requestHash: commissionSettlements.requestHash,
      })
      .from(commissionSettlements)
      .where(and(eq(commissionSettlements.locationId, cmd.locationId), eq(commissionSettlements.idempotencyKey, cmd.idempotencyKey)));
    if (existing) {
      assertSameRequest(existing, hash);
      return { settlementId: existing.id, publicId: existing.publicId, number: existing.number, payout: existing.payout, created: false };
    }

    const person = await lockStaff(tx, cmd.locationId, cmd.staffId);
    const now = cmd.now ?? new Date();
    const day = await requireOpenDay(tx, cmd.locationId, now, (m) => new SettlementError(m));
    // Con los datos de esta transacción: el dueño nunca paga un monto distinto del que vio.
    const preview = await previewSettlement(tx, { ...cmd, now });
    if (preview.previewToken !== cmd.previewToken) {
      throw new SettlementError("La liquidación cambió desde que la abriste (entró un cobro, una anulación o un pago). Revísala otra vez.");
    }
    const { draft } = preview;
    const payout = draft.payout.minor;
    const paidFrom: PaidFrom | null = payout === 0n ? null : cmd.paidFrom;
    // Un pago de $0 no mueve dinero: no pide caja abierta.
    const session = paidFrom === "cash" ? await requireOpenSession(tx, cmd.locationId, "Abre la caja para pagar en efectivo", now) : null;
    if (session && payout > (await ledgerCash(tx, cmd.locationId))) throw cashShortError(cmd.actor);

    const posted = await postEntry(tx, {
      locationId: cmd.locationId,
      createdBy: cmd.actor.userId,
      entry: settlementEntry(draft, {
        businessDate: day,
        memo: `Liquidación de comisiones a ${person.name}`,
        idempotencyKey: `settlement:${cmd.idempotencyKey}`,
        paidFrom,
      }),
    });
    // El número y la hora los pone la base (trigger de 0013).
    const [row] = await tx
      .insert(commissionSettlements)
      .values({
        locationId: cmd.locationId,
        publicId: ulid(now.getTime()),
        staffId: cmd.staffId,
        periodFrom: preview.periodFromDate ?? cmd.cutoffDate,
        cutoffDate: cmd.cutoffDate,
        businessDate: day,
        paidFrom,
        cashSessionId: session?.id ?? null,
        commissionTotal: draft.commissionTotal.minor,
        clawbackTotal: draft.clawbackTotal.minor,
        tipsTotal: draft.tips.minor,
        adjustmentsTotal: draft.adjustmentsTotal.minor,
        advanceDeduction: draft.advanceDeduction.minor,
        carryOver: draft.carryOver.minor,
        payout,
        journalEntryId: posted.entryId,
        note,
        createdBy: cmd.actor.userId,
        idempotencyKey: cmd.idempotencyKey,
        requestHash: hash,
      })
      .returning({ id: commissionSettlements.id, publicId: commissionSettlements.publicId, number: commissionSettlements.number });
    // Por tandas: un corte con años de historia no debe chocar con el tope de parámetros de Postgres.
    for (let start = 0; start < draft.lines.length; start += LINE_INSERT_CHUNK) {
      await tx.insert(commissionSettlementLines).values(
        draft.lines.slice(start, start + LINE_INSERT_CHUNK).map((l) => ({
          locationId: cmd.locationId,
          settlementId: row!.id,
          kind: l.kind,
          saleLineId: l.saleLineId ?? null,
          amount: l.amount.minor,
          reason: l.reason ?? null,
        })),
      );
    }
    const numberLabel = receiptNumberLabel(row!.number);
    if (session) {
      await tx.insert(cashMovements).values({
        locationId: cmd.locationId,
        cashSessionId: session.id,
        kind: "commission_payout",
        journalEntryId: posted.entryId,
        staffId: cmd.staffId,
        description: `Liquidación ${numberLabel} a ${person.name}`.slice(0, 200),
        createdBy: cmd.actor.userId,
      });
    }
    await recordAudit(tx, {
      locationId: cmd.locationId,
      actorUserId: cmd.actor.userId,
      action: "settlement.create",
      targetKind: "commission_settlement",
      targetRef: row!.publicId,
      summary: `Liquidación ${numberLabel} a ${person.name} por ${format(draft.payout)}${paidFrom ? (paidFrom === "cash" ? ", de la caja" : ", del banco") : ", sin pago"}`,
    });
    return { settlementId: row!.id, publicId: row!.publicId, number: row!.number, payout, created: true };
  });
}

/** Solo la última vigente, en el día contable de hoy; sus líneas vuelven a quedar pendientes. */
export async function reverseSettlement(
  db: Db,
  cmd: { locationId: bigint; publicId: string; reason: string; idempotencyKey: string; actor: ActorRef; now?: Date },
): Promise<{ created: boolean }> {
  const reason = requireSettlementReason(cmd.reason, "el motivo de la reversa");
  const hash = requestHash({ kind: "settlement_reversal", locationId: cmd.locationId, publicId: cmd.publicId, reason, by: cmd.actor.userId });
  return serializable(db, async (tx) => {
    const [replay] = await tx
      .select({ requestHash: commissionSettlements.reversalRequestHash })
      .from(commissionSettlements)
      .where(and(eq(commissionSettlements.locationId, cmd.locationId), eq(commissionSettlements.reversalIdempotencyKey, cmd.idempotencyKey)));
    if (replay) {
      assertSameRequest(replay, hash);
      return { created: false };
    }
    const where = and(eq(commissionSettlements.locationId, cmd.locationId), eq(commissionSettlements.publicId, cmd.publicId));
    const [found] = await tx.select({ staffId: commissionSettlements.staffId }).from(commissionSettlements).where(where);
    if (!found) throw new SettlementError("La liquidación no existe");
    // Primero la persona, como en todo lo que mueve sus saldos; después la liquidación.
    const person = await lockStaff(tx, cmd.locationId, found.staffId);
    const [st] = await tx
      .select({
        id: commissionSettlements.id,
        number: commissionSettlements.number,
        status: commissionSettlements.status,
        paidFrom: commissionSettlements.paidFrom,
        payout: commissionSettlements.payout,
        advanceDeduction: commissionSettlements.advanceDeduction,
        carryOver: commissionSettlements.carryOver,
        journalEntryId: commissionSettlements.journalEntryId,
      })
      .from(commissionSettlements)
      .where(where)
      .for("update");
    const [latest] = await tx
      .select({ number: commissionSettlements.number })
      .from(commissionSettlements)
      .where(and(eq(commissionSettlements.locationId, cmd.locationId), eq(commissionSettlements.staffId, found.staffId), eq(commissionSettlements.status, "settled")))
      .orderBy(desc(commissionSettlements.number))
      .limit(1);
    assertReversible({ status: st!.status, number: st!.number, latestActiveNumber: latest?.number ?? null, staffName: person.name });
    // Revertir devuelve lo descontado a 1365 y quita lo arrastrado. Si el saldo quedaría negativo, lo
    // arrastrado ya se compensó por otro lado; se dice aquí, antes del trigger diferido del libro.
    const [before] = await commissionBalances(tx, cmd.locationId, { staffId: found.staffId });
    if ((before?.receivable ?? 0n) + st!.advanceDeduction - st!.carryOver < 0n) {
      throw new SettlementError(
        `No se puede revertir: lo que debe ${person.name} quedaría negativo, porque el saldo que arrastra esta liquidación ya se compensó. Revisa sus anticipos revertidos.`,
      );
    }

    const day = await requireOpenDay(tx, cmd.locationId, cmd.now ?? new Date(), (m) => new SettlementError(m));
    const session = st!.paidFrom === "cash" ? await requireOpenSession(tx, cmd.locationId, "Abre la caja para recibir el efectivo de vuelta", cmd.now) : null;
    const reversal = await reverseEntry(tx, {
      locationId: cmd.locationId,
      entryId: st!.journalEntryId,
      businessDate: day,
      reason,
      createdBy: cmd.actor.userId,
    });
    await tx
      .update(commissionSettlements)
      .set({
        status: "reversed",
        reversalEntryId: reversal.entryId,
        reversedAt: sql`now()`,
        reversedBy: cmd.actor.userId,
        reversalReason: reason,
        reversalIdempotencyKey: cmd.idempotencyKey,
        reversalRequestHash: hash,
      })
      .where(eq(commissionSettlements.id, st!.id));
    await tx
      .update(commissionSettlementLines)
      .set({ reversed: true })
      .where(and(eq(commissionSettlementLines.locationId, cmd.locationId), eq(commissionSettlementLines.settlementId, st!.id)));
    const numberLabel = receiptNumberLabel(st!.number);
    if (session) {
      await tx.insert(cashMovements).values({
        locationId: cmd.locationId,
        cashSessionId: session.id,
        kind: "reversal",
        journalEntryId: reversal.entryId,
        description: `Reversa de la liquidación ${numberLabel} de ${person.name}`.slice(0, 200),
        createdBy: cmd.actor.userId,
      });
    }
    await recordAudit(tx, {
      locationId: cmd.locationId,
      actorUserId: cmd.actor.userId,
      action: "settlement.reverse",
      targetKind: "commission_settlement",
      targetRef: cmd.publicId,
      summary: `Revirtió la liquidación ${numberLabel} de ${person.name} por ${format(money(st!.payout))}`,
    });
    return { created: true };
  });
}

// ─── Anticipos ───────────────────────────────────────────────────────────────

export async function giveAdvance(
  db: Db,
  cmd: { locationId: bigint; staffId: bigint; amount: Money; paidFrom: PaidFrom; reason: string; idempotencyKey: string; actor: ActorRef; now?: Date },
): Promise<{ advanceId: bigint; publicId: string; number: bigint; created: boolean }> {
  const reason = requireSettlementReason(cmd.reason, "el motivo del anticipo");
  const hash = requestHash({
    kind: "staff_advance",
    locationId: cmd.locationId,
    staffId: cmd.staffId,
    amount: cmd.amount.minor,
    paidFrom: cmd.paidFrom,
    reason,
    by: cmd.actor.userId,
  });
  return serializable(db, async (tx) => {
    const [existing] = await tx
      .select({ id: staffAdvances.id, publicId: staffAdvances.publicId, number: staffAdvances.number, requestHash: staffAdvances.requestHash })
      .from(staffAdvances)
      .where(and(eq(staffAdvances.locationId, cmd.locationId), eq(staffAdvances.idempotencyKey, cmd.idempotencyKey)));
    if (existing) {
      assertSameRequest(existing, hash);
      return { advanceId: existing.id, publicId: existing.publicId, number: existing.number, created: false };
    }
    const person = await lockStaff(tx, cmd.locationId, cmd.staffId);
    if (!person.active) throw new SettlementError(`${person.name} ya no está activo en la sede`);
    const now = cmd.now ?? new Date();
    const day = await requireOpenDay(tx, cmd.locationId, now, (m) => new SettlementError(m));
    const session = cmd.paidFrom === "cash" ? await requireOpenSession(tx, cmd.locationId, "Abre la caja para entregar el anticipo", now) : null;
    const entry = staffAdvanceEntry(cmd.amount, cmd.paidFrom, {
      businessDate: day,
      memo: `Anticipo a ${person.name}`,
      idempotencyKey: `advance:${cmd.idempotencyKey}`,
    });
    if (session && cmd.amount.minor > (await ledgerCash(tx, cmd.locationId))) throw cashShortError(cmd.actor);
    const posted = await postEntry(tx, { locationId: cmd.locationId, createdBy: cmd.actor.userId, entry });
    const [row] = await tx
      .insert(staffAdvances)
      .values({
        locationId: cmd.locationId,
        publicId: ulid(now.getTime()),
        staffId: cmd.staffId,
        amount: cmd.amount.minor,
        paidFrom: cmd.paidFrom,
        cashSessionId: session?.id ?? null,
        businessDate: day,
        reason,
        journalEntryId: posted.entryId,
        createdBy: cmd.actor.userId,
        idempotencyKey: cmd.idempotencyKey,
        requestHash: hash,
      })
      .returning({ id: staffAdvances.id, publicId: staffAdvances.publicId, number: staffAdvances.number });
    const numberLabel = receiptNumberLabel(row!.number);
    if (session) {
      await tx.insert(cashMovements).values({
        locationId: cmd.locationId,
        cashSessionId: session.id,
        kind: "staff_advance",
        journalEntryId: posted.entryId,
        staffId: cmd.staffId,
        description: `Anticipo ${numberLabel} a ${person.name}`.slice(0, 200),
        createdBy: cmd.actor.userId,
      });
    }
    await recordAudit(tx, {
      locationId: cmd.locationId,
      actorUserId: cmd.actor.userId,
      action: "advance.create",
      targetKind: "staff_advance",
      targetRef: row!.publicId,
      summary: `Anticipo ${numberLabel} a ${person.name} por ${format(cmd.amount)}, ${cmd.paidFrom === "cash" ? "de la caja" : "del banco"}`,
    });
    return { advanceId: row!.id, publicId: row!.publicId, number: row!.number, created: true };
  });
}

export async function reverseAdvance(
  db: Db,
  cmd: { locationId: bigint; publicId: string; reason: string; idempotencyKey: string; actor: ActorRef; now?: Date },
): Promise<{ created: boolean }> {
  const reason = requireSettlementReason(cmd.reason, "el motivo de la reversa");
  const hash = requestHash({ kind: "advance_reversal", locationId: cmd.locationId, publicId: cmd.publicId, reason, by: cmd.actor.userId });
  return serializable(db, async (tx) => {
    const [replay] = await tx
      .select({ requestHash: staffAdvances.reversalRequestHash })
      .from(staffAdvances)
      .where(and(eq(staffAdvances.locationId, cmd.locationId), eq(staffAdvances.reversalIdempotencyKey, cmd.idempotencyKey)));
    if (replay) {
      assertSameRequest(replay, hash);
      return { created: false };
    }
    const where = and(eq(staffAdvances.locationId, cmd.locationId), eq(staffAdvances.publicId, cmd.publicId));
    const [found] = await tx.select({ staffId: staffAdvances.staffId }).from(staffAdvances).where(where);
    if (!found) throw new SettlementError("El anticipo no existe");
    const person = await lockStaff(tx, cmd.locationId, found.staffId);
    const [advance] = await tx
      .select({
        id: staffAdvances.id,
        number: staffAdvances.number,
        status: staffAdvances.status,
        amount: staffAdvances.amount,
        paidFrom: staffAdvances.paidFrom,
        createdAt: staffAdvances.createdAt,
        journalEntryId: staffAdvances.journalEntryId,
      })
      .from(staffAdvances)
      .where(where)
      .for("update");
    if (advance!.status === "reversed") throw new SettlementError("Este anticipo ya está revertido");
    // Una liquidación posterior pudo descontar este anticipo o arrastrar saldo sobre él. Revertirlo
    // dejaría esa liquidación sin poder revertirse: primero se revierte ella.
    const [blocking] = await tx
      .select({ number: commissionSettlements.number })
      .from(commissionSettlements)
      .where(
        and(
          eq(commissionSettlements.locationId, cmd.locationId),
          eq(commissionSettlements.staffId, found.staffId),
          eq(commissionSettlements.status, "settled"),
          gt(commissionSettlements.createdAt, advance!.createdAt),
          or(gt(commissionSettlements.advanceDeduction, 0n), gt(commissionSettlements.carryOver, 0n)),
        ),
      )
      .orderBy(desc(commissionSettlements.number))
      .limit(1);
    if (blocking) {
      throw new SettlementError(`La liquidación ${receiptNumberLabel(blocking.number)} se hizo después de este anticipo y lo tiene en cuenta; revierte esa liquidación primero`);
    }
    const [balance] = await commissionBalances(tx, cmd.locationId, { staffId: found.staffId });
    if ((balance?.receivable ?? 0n) < advance!.amount) {
      throw new SettlementError("Este anticipo ya se descontó en una liquidación; revierte esa liquidación primero");
    }
    const day = await requireOpenDay(tx, cmd.locationId, cmd.now ?? new Date(), (m) => new SettlementError(m));
    const session = advance!.paidFrom === "cash" ? await requireOpenSession(tx, cmd.locationId, "Abre la caja para recibir el efectivo de vuelta", cmd.now) : null;
    const reversal = await reverseEntry(tx, {
      locationId: cmd.locationId,
      entryId: advance!.journalEntryId,
      businessDate: day,
      reason,
      createdBy: cmd.actor.userId,
    });
    await tx
      .update(staffAdvances)
      .set({
        status: "reversed",
        reversalEntryId: reversal.entryId,
        reversedAt: sql`now()`,
        reversedBy: cmd.actor.userId,
        reversalReason: reason,
        reversalIdempotencyKey: cmd.idempotencyKey,
        reversalRequestHash: hash,
      })
      .where(eq(staffAdvances.id, advance!.id));
    const numberLabel = receiptNumberLabel(advance!.number);
    if (session) {
      await tx.insert(cashMovements).values({
        locationId: cmd.locationId,
        cashSessionId: session.id,
        kind: "reversal",
        journalEntryId: reversal.entryId,
        description: `Reversa del anticipo ${numberLabel} de ${person.name}`.slice(0, 200),
        createdBy: cmd.actor.userId,
      });
    }
    await recordAudit(tx, {
      locationId: cmd.locationId,
      actorUserId: cmd.actor.userId,
      action: "advance.reverse",
      targetKind: "staff_advance",
      targetRef: cmd.publicId,
      summary: `Revirtió el anticipo ${numberLabel} de ${person.name} por ${format(money(advance!.amount))}`,
    });
    return { created: true };
  });
}

// ─── Lecturas ────────────────────────────────────────────────────────────────

/** Historial de la persona. null si no es de esta sede. */
export async function staffCommissionDetail(
  db: Db,
  input: { locationId: bigint; staffId: bigint; historyLimit?: number; now?: Date },
): Promise<StaffCommissionDetail | null> {
  const limit = input.historyLimit ?? 24;
  const [person] = await db
    .select({ name: staffMembers.displayName, active: staffMembers.active })
    .from(staffMembers)
    .where(and(eq(staffMembers.locationId, input.locationId), eq(staffMembers.id, input.staffId)));
  if (!person) return null;
  const day = await today(db, input.locationId, input.now ?? new Date());
  const session = await sessionOpenOn(db, input.locationId, day.businessDate);
  const settlements = await db
    .select({
      publicId: commissionSettlements.publicId,
      number: commissionSettlements.number,
      businessDate: commissionSettlements.businessDate,
      cutoffDate: commissionSettlements.cutoffDate,
      payout: commissionSettlements.payout,
      paidFrom: commissionSettlements.paidFrom,
      status: commissionSettlements.status,
    })
    .from(commissionSettlements)
    .where(and(eq(commissionSettlements.locationId, input.locationId), eq(commissionSettlements.staffId, input.staffId)))
    .orderBy(desc(commissionSettlements.number))
    .limit(limit);
  const advances = await db
    .select({
      publicId: staffAdvances.publicId,
      number: staffAdvances.number,
      businessDate: staffAdvances.businessDate,
      amount: staffAdvances.amount,
      reason: staffAdvances.reason,
      paidFrom: staffAdvances.paidFrom,
      status: staffAdvances.status,
    })
    .from(staffAdvances)
    .where(and(eq(staffAdvances.locationId, input.locationId), eq(staffAdvances.staffId, input.staffId)))
    .orderBy(desc(staffAdvances.number))
    .limit(limit);
  const [balance] = await commissionBalances(db, input.locationId, { staffId: input.staffId });
  const receivable = balance?.receivable ?? 0n;
  const latestActive = settlements.find((s) => s.status === "settled")?.number ?? null;
  return {
    staff: { id: input.staffId, name: person.name, active: person.active },
    businessDate: day.businessDate,
    dayClosed: day.closed,
    cashSessionOpen: session,
    lastCutoffDate: await lastCutoff(db, input.locationId, input.staffId),
    settlements: settlements.map((s) => ({ ...s, canReverse: s.number === latestActive })),
    advances: advances.map((a) => ({ ...a, canReverse: a.status === "active" && receivable >= a.amount })),
  };
}

/** Liquidación o anticipo de la sede, con staffId para el control de acceso (lo hace la acción). */
export async function receiptByPublicId(db: Db, input: { locationId: bigint; publicId: string }): Promise<ReceiptData | null> {
  const [location] = await db.select({ name: locations.name, timezone: locations.timezone }).from(locations).where(eq(locations.id, input.locationId));
  if (!location) return null;
  const common = { locationName: location.name, timeZone: location.timezone, publicId: input.publicId };

  const [st] = rowsOf<{
    id: string;
    number: string;
    staff_id: string;
    staff_name: string;
    business_date: string;
    created_at: Date | string;
    created_by_name: string | null;
    status: "settled" | "reversed";
    paid_from: PaidFrom | null;
    period_from: string;
    cutoff_date: string;
    tips_total: string;
    advance_deduction: string;
    carry_over: string;
    commission_total: string;
    clawback_total: string;
    adjustments_total: string;
    payout: string;
    note: string | null;
    reversed_at: Date | string | null;
    reversed_by_name: string | null;
    reversal_reason: string | null;
  }>(
    await db.execute(sql`
      select st.id::text as id, st.number::text as number, st.staff_id::text as staff_id, m.display_name as staff_name,
             st.business_date::text as business_date, st.created_at, c.display_name as created_by_name, st.status, st.paid_from,
             st.period_from::text as period_from, st.cutoff_date::text as cutoff_date, st.tips_total::text as tips_total,
             st.advance_deduction::text as advance_deduction, st.carry_over::text as carry_over,
             st.commission_total::text as commission_total, st.clawback_total::text as clawback_total,
             st.adjustments_total::text as adjustments_total, st.payout::text as payout, st.note, st.reversed_at,
             r.display_name as reversed_by_name, st.reversal_reason
        from commission_settlements st
        join staff_members m on m.location_id = st.location_id and m.id = st.staff_id
        left join staff_members c on c.location_id = st.location_id and c.user_id = st.created_by
        left join staff_members r on r.location_id = st.location_id and r.user_id = st.reversed_by
       where st.location_id = ${input.locationId}::bigint and st.public_id = ${input.publicId}
    `),
  );
  if (st) {
    const lines = rowsOf<{
      kind: string;
      amount: string;
      reason: string | null;
      business_date: string | null;
      description: string | null;
      net: string | null;
      commission_bps: number | null;
      paid_number: string | null;
    }>(
      await db.execute(sql`
        select c.kind, c.amount::text as amount, c.reason, s.business_date::text as business_date, l.description,
               l.net::text as net, l.commission_bps,
               (select o.number::text from commission_settlement_lines x
                  join commission_settlements o on o.location_id = x.location_id and o.id = x.settlement_id
                 where x.location_id = c.location_id and x.sale_line_id = c.sale_line_id and x.kind = 'commission' and x.settlement_id <> c.settlement_id
                 order by x.reversed, o.number desc limit 1) as paid_number
          from commission_settlement_lines c
          left join sale_lines l on l.location_id = c.location_id and l.id = c.sale_line_id
          left join sales s on s.location_id = l.location_id and s.id = l.sale_id
         where c.location_id = ${input.locationId}::bigint and c.settlement_id = ${st.id}::bigint
         order by s.business_date nulls last, c.id
      `),
    );
    const ofKind = (kind: string) => lines.filter((l) => l.kind === kind);
    return {
      ...common,
      kind: "settlement",
      number: BigInt(st.number),
      staffId: BigInt(st.staff_id),
      staffName: st.staff_name,
      businessDate: st.business_date,
      createdAt: new Date(st.created_at),
      createdBy: st.created_by_name ?? "Personal",
      reversal: st.reversed_at ? { at: new Date(st.reversed_at), by: st.reversed_by_name ?? "Personal", reason: st.reversal_reason ?? "" } : null,
      status: st.status,
      paidFrom: st.paid_from,
      periodFrom: st.period_from,
      cutoffDate: st.cutoff_date,
      commissions: ofKind("commission").map((l) => ({
        businessDate: l.business_date!,
        description: l.description!,
        net: big(l.net),
        commissionBps: Number(l.commission_bps),
        commission: BigInt(l.amount),
      })),
      clawbacks: ofKind("clawback").map((l) => ({
        businessDate: l.business_date!,
        description: l.description!,
        amount: -BigInt(l.amount),
        settlementNumber: l.paid_number === null ? null : BigInt(l.paid_number),
      })),
      tips: BigInt(st.tips_total),
      adjustments: ofKind("adjustment").map((l) => ({ amount: BigInt(l.amount), reason: l.reason ?? "" })),
      advanceDeduction: BigInt(st.advance_deduction),
      carryOver: BigInt(st.carry_over),
      commissionTotal: BigInt(st.commission_total),
      clawbackTotal: BigInt(st.clawback_total),
      adjustmentsTotal: BigInt(st.adjustments_total),
      payout: BigInt(st.payout),
      note: st.note,
    };
  }

  const [adv] = rowsOf<{
    number: string;
    staff_id: string;
    staff_name: string;
    business_date: string;
    created_at: Date | string;
    created_by_name: string | null;
    status: "active" | "reversed";
    paid_from: PaidFrom;
    amount: string;
    reason: string;
    reversed_at: Date | string | null;
    reversed_by_name: string | null;
    reversal_reason: string | null;
  }>(
    await db.execute(sql`
      select a.number::text as number, a.staff_id::text as staff_id, m.display_name as staff_name, a.business_date::text as business_date,
             a.created_at, c.display_name as created_by_name, a.status, a.paid_from, a.amount::text as amount, a.reason, a.reversed_at,
             r.display_name as reversed_by_name, a.reversal_reason
        from staff_advances a
        join staff_members m on m.location_id = a.location_id and m.id = a.staff_id
        left join staff_members c on c.location_id = a.location_id and c.user_id = a.created_by
        left join staff_members r on r.location_id = a.location_id and r.user_id = a.reversed_by
       where a.location_id = ${input.locationId}::bigint and a.public_id = ${input.publicId}
    `),
  );
  if (!adv) return null;
  return {
    ...common,
    kind: "advance",
    number: BigInt(adv.number),
    staffId: BigInt(adv.staff_id),
    staffName: adv.staff_name,
    businessDate: adv.business_date,
    createdAt: new Date(adv.created_at),
    createdBy: adv.created_by_name ?? "Personal",
    reversal: adv.reversed_at ? { at: new Date(adv.reversed_at), by: adv.reversed_by_name ?? "Personal", reason: adv.reversal_reason ?? "" } : null,
    status: adv.status,
    paidFrom: adv.paid_from,
    amount: BigInt(adv.amount),
    reason: adv.reason,
  };
}
