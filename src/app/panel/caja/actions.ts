"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  cashDeposit,
  cashViewData,
  closeBusinessDay,
  closeCashSession,
  markSessionReviewed,
  type MovementKind,
  openCashSession,
  payTips,
  reopenBusinessDay,
  today,
} from "@/db/cash";
import { checkoutRulesOf } from "@/db/checkout-settings";
import { db } from "@/db/client";
import { giveCourtesy } from "@/db/courtesies";
import { cashSessionsInPeriod } from "@/db/history";
import { readOnlySnapshot } from "@/db/reports";
import { addExpense } from "@/db/expenses";
import { dueRecurringExpenses } from "@/db/recurring-expenses";
import type { Db } from "@/db/types";
import { deliveryStatus } from "@/db/worker-heartbeat";
import { money, sum } from "@/domain/money";
import { historyPeriod, type HistoryPeriodView } from "@/domain/reports/period";
import { formatDateLabel } from "@/domain/booking/public-labels";
import { CashError, sessionIsFromEarlierDay } from "@/domain/sales/cash";
import { canGiveCourtesy } from "@/domain/sales/courtesy";
import { can, canDiscount } from "@/domain/staff/roles";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { dateSchema, idempotencyKeySchema, unitsSchema } from "@/lib/action-schemas";
import { absLabel, atLabel, minorText, moneyLabel, signedLabel } from "@/lib/labels";
import { requirePermission, requireRecentAuth } from "@/lib/session";
import { dueItems, type RecurringDueItem, sortDue } from "../gastos-fijos/view";

// Caja (docs/sprint-4-cobro-caja.md §4 y §9). El esperado sale SIEMPRE de SQL (saldo de 1105);
// la sede y el día contable salen de la sesión y de la base, nunca del navegador.
//
// Conteo a ciegas (§9.2, MEDIUM-3): con la caja abierta, solo quien tiene cash.review (el dueño)
// recibe el esperado, su desglose y los montos de los movimientos. Los demás cuentan sin saber
// cuánto "debería" haber y ven el esperado y la diferencia solo después de cerrar.

const database = () => db() as unknown as Db;

function refresh() {
  revalidatePath("/panel/caja");
}

export interface CashView {
  businessDate: string;
  dayClosed: boolean;
  /**
   * Saldo actual de 1105 en el libro: con la caja cerrada, sirve para prever la diferencia al abrir.
   * null con la caja abierta para quien cuenta a ciegas: sería el esperado del turno.
   */
  expectedOpeningMinor: string | null;
  expectedOpeningLabel: string | null;
  session: null | {
    id: string;
    /** Día contable del turno (fecha local de la apertura). */
    businessDate: string;
    /**
     * El turno quedó abierto de un día anterior ("lunes 3 de noviembre"): no recibe efectivo de hoy.
     * Se cierra contando y luego se abre la caja de hoy. null si es de hoy.
     */
    staleDayLabel: string | null;
    openedAtLabel: string;
    openedBy: string;
    /** Conteo a ciegas: null para quien no tiene cash.review (el servidor nunca lo manda). */
    expectedMinor: string | null;
    expectedLabel: string | null;
    /** Vacío en el conteo a ciegas. */
    breakdown: { label: string; amountLabel: string; sign: "+" | "-" | "±" }[];
    byMethod: { label: string; totalLabel: string }[];
    movements: {
      at: string;
      kind: "sale" | "expense" | "tip_payout" | "cash_deposit" | "cash_adjustment" | "reversal" | "commission_payout" | "staff_advance";
      description: string;
      /** null en el conteo a ciegas: sumados con la base darían el esperado. */
      amountLabel: string | null;
      sign: "+" | "-";
    }[];
  };
  /** Conteo a ciegas: quien cierra no ve el esperado con la caja abierta y siempre deja nota. */
  blindCount: boolean;
  lastClosed: null | { closedAtLabel: string; countedLabel: string; differenceLabel: string; note: string | null };
  /**
   * Solo para quien tiene cash.review: turnos con diferencia de apertura o de cierre mayor que el
   * umbral, sin revisar. Uno abierto aparece si su apertura quedó marcada; se revisa al cerrarlo.
   */
  flaggedSessions: {
    id: string;
    open: boolean;
    /** openedBy: quien abrió, responsable de la diferencia de apertura. */
    opening: null | { atLabel: string; openedBy: string; expectedLabel: string; countedLabel: string; differenceLabel: string; note: string | null };
    closing: null | {
      flagged: boolean;
      atLabel: string;
      closedBy: string;
      expectedLabel: string;
      countedLabel: string;
      differenceLabel: string;
      note: string | null;
    };
  }[];
  tipsOwed: { staffId: string; name: string; owedMinor: string; owedLabel: string }[];
  categories: { id: string; name: string }[];
  /**
   * Gastos fijos de caja vencidos o por vencer (sprint 8, §5): un aviso con "Registrar", que abre el
   * formulario de gasto prellenado. Nada se asienta solo.
   */
  recurringDue: RecurringDueItem[];
  canBankExpense: boolean;
  canCloseDay: boolean;
  canReopenDay: boolean;
  /** Abrir la caja aunque hoy esté cerrado (lo reabre en la misma operación): recepción y dueño. */
  canReopenToday: boolean;
  /** Si hoy se reabrió: quién, a qué hora y por qué (lo ve todo el que entra a Caja). */
  todayReopened: null | { by: string; atLabel: string; reason: string };
  /** Citas de hoy en la silla o terminadas, sin cobrar: lo primero que ve quien cobra. */
  /** Día anterior con movimientos y sin cerrar (cierre tardío o se olvidó): se cierra desde Caja. */
  pendingDay: null | { date: string; label: string };
  toCharge: { appointmentId: string; timeLabel: string; clientName: string | null; serviceName: string; staffName: string; priceLabel: string; inChair: boolean }[];
  /**
   * Dar una cita de "Por cobrar" como cortesía (sprint 8, §4): quien puede dar descuentos y solo si el
   * tope de descuento de la sede es 100 %. El servidor lo vuelve a exigir al darla.
   */
  canCourtesy: boolean;
  /**
   * Hay recibos o avisos de la sede en cola y el worker no late hace más de 5 minutos (migración
   * 0030): los envíos están detenidos. Solo el booleano; nada de los clientes.
   */
  deliveryStalled: boolean;
  daySales: {
    saleId: string;
    /** Para abrir el recibo (/panel/ventas/<publicId>). */
    publicId: string;
    atLabel: string;
    clientName: string | null;
    totalLabel: string;
    status: "paid" | "voided";
    voidRequested: boolean;
    chargedBy: string;
  }[];
}

const BREAKDOWN: { kinds: MovementKind[]; label: string; sign: "+" | "-" }[] = [
  { kinds: ["sale"], label: "Ventas en efectivo (neto de cambio)", sign: "+" },
  { kinds: ["expense"], label: "Gastos de caja", sign: "-" },
  { kinds: ["tip_payout"], label: "Propinas pagadas en efectivo", sign: "-" },
  { kinds: ["commission_payout", "staff_advance"], label: "Pagos al personal (liquidaciones y anticipos)", sign: "-" },
  { kinds: ["cash_deposit"], label: "Consignaciones", sign: "-" },
  { kinds: ["reversal"], label: "Anulaciones y reversas", sign: "-" },
];

export async function loadCashView(): Promise<ActionResult<CashView>> {
  const staff = await requirePermission("ledger.post");
  return runAction(async () => {
    // Todo en UNA transacción REPEATABLE READ de solo lectura (L3): una sola foto del libro.
    const { day, summary, closed, owed, categories, sales, ledger, flagged, toCharge, pendingDay, reopened } = await cashViewData(database(), staff.locationId);
    const rules = await checkoutRulesOf(database(), staff.locationId);
    const recurring = await dueRecurringExpenses(database(), { locationId: staff.locationId, payMode: "cash" });
    const delivery = await deliveryStatus(database(), staff.locationId);
    const tz = day.timeZone;
    const canReview = can(staff.role, "cash.review");
    const blind = !canReview;

    let session: CashView["session"] = null;
    if (summary) {
      const breakdown: NonNullable<CashView["session"]>["breakdown"] = [
        { label: "Base contada al abrir", amountLabel: moneyLabel(summary.openingCounted), sign: "+" },
      ];
      for (const b of BREAKDOWN) {
        const net = sum(b.kinds.map((kind) => money(summary.byKind.get(kind) ?? 0n))).minor;
        if (net === 0n && !b.kinds.includes("sale")) continue;
        // Las ventas suman y lo demás resta; si una anulación o un ajuste va al revés, se muestra con ±.
        const natural = b.sign === "+" ? net >= 0n : net <= 0n;
        breakdown.push(natural ? { label: b.label, amountLabel: absLabel(net), sign: b.sign } : { label: b.label, amountLabel: signedLabel(net), sign: "±" });
      }
      if (summary.unexplained !== 0n) {
        breakdown.push({ label: "Otros movimientos del libro", amountLabel: signedLabel(summary.unexplained), sign: "±" });
      }
      session = {
        id: summary.id.toString(),
        businessDate: summary.businessDate,
        staleDayLabel: sessionIsFromEarlierDay(summary.businessDate, day.businessDate) ? formatDateLabel(summary.businessDate) : null,
        openedAtLabel: atLabel(summary.openedAt, tz, day.businessDate),
        openedBy: summary.openedBy,
        expectedMinor: blind ? null : minorText(summary.expected),
        expectedLabel: blind ? null : moneyLabel(summary.expected),
        breakdown: blind ? [] : breakdown,
        byMethod: summary.byMethod.map((m) => ({ label: m.label, totalLabel: moneyLabel(m.total) })),
        movements: summary.movements.map((m) => ({
          at: atLabel(m.at, tz, day.businessDate),
          kind: m.kind,
          description: m.description,
          amountLabel: blind ? null : absLabel(m.net),
          sign: m.net >= 0n ? "+" : "-",
        })),
      };
    }

    return {
      businessDate: day.businessDate,
      dayClosed: day.closed,
      // Con la caja abierta, el saldo de 1105 ES el esperado: solo para quien tiene cash.review.
      // El saldo de 1105 es el esperado al abrir y durante el turno: a ciegas, nunca llega (MEDIUM-2).
      expectedOpeningMinor: blind ? null : minorText(ledger),
      expectedOpeningLabel: blind ? null : moneyLabel(ledger),
      session,
      blindCount: blind,
      lastClosed: closed
        ? {
            closedAtLabel: atLabel(closed.closedAt, tz, day.businessDate),
            countedLabel: moneyLabel(closed.counted),
            differenceLabel: signedLabel(closed.difference),
            note: closed.note,
          }
        : null,
      flaggedSessions: canReview
        ? flagged.map((f) => ({
            id: f.id.toString(),
            open: f.closedAt === null,
            opening: f.openingNeedsReview
              ? {
                  atLabel: atLabel(f.openedAt, tz, day.businessDate),
                  openedBy: f.openedBy ?? "Personal",
                  expectedLabel: moneyLabel(f.openingExpected),
                  countedLabel: moneyLabel(f.openingCounted),
                  differenceLabel: signedLabel(f.openingCounted - f.openingExpected),
                  note: f.openingNote,
                }
              : null,
            closing: f.closedAt
              ? {
                  flagged: f.needsReview,
                  atLabel: atLabel(f.closedAt, tz, day.businessDate),
                  closedBy: f.closedBy ?? "Personal",
                  expectedLabel: moneyLabel(f.expected ?? 0n),
                  countedLabel: moneyLabel(f.counted ?? 0n),
                  differenceLabel: signedLabel(f.difference ?? 0n),
                  note: f.note,
                }
              : null,
          }))
        : [],
      tipsOwed: owed.map((t) => ({ staffId: t.staffId.toString(), name: t.name, owedMinor: minorText(t.owed), owedLabel: moneyLabel(t.owed) })),
      categories: categories.map((c) => ({ id: c.id.toString(), name: c.name })),
      recurringDue: sortDue(dueItems(recurring.items)),
      canBankExpense: can(staff.role, "expenses.bank"),
      canCloseDay: can(staff.role, "day.close"),
      canReopenDay: can(staff.role, "day.reopen"),
      canReopenToday: can(staff.role, "day.reopen.today"),
      todayReopened: reopened ? { by: reopened.by, atLabel: atLabel(reopened.at, tz, day.businessDate), reason: reopened.reason } : null,
      pendingDay: pendingDay ? { date: pendingDay, label: formatDateLabel(pendingDay) } : null,
      toCharge: toCharge.map((a) => ({
        appointmentId: a.appointmentId.toString(),
        timeLabel: atLabel(a.start, tz, day.businessDate),
        clientName: a.clientName,
        serviceName: a.serviceName,
        staffName: a.staffName,
        priceLabel: moneyLabel(a.price),
        inChair: a.status === "in_chair",
      })),
      canCourtesy: canGiveCourtesy(staff.role, rules),
      deliveryStalled: delivery.stalled,
      daySales: sales.map((s) => ({
        saleId: s.saleId.toString(),
        publicId: s.publicId,
        atLabel: atLabel(s.at, tz, day.businessDate),
        clientName: s.clientName,
        totalLabel: moneyLabel(s.total),
        status: s.status,
        voidRequested: s.voidRequested,
        chargedBy: s.chargedBy ?? "Personal",
      })),
    };
  });
}

// ─── Turno ───────────────────────────────────────────────────────────────────

const countInput = z.object({
  countedUnits: unitsSchema("El efectivo contado"),
  note: z.string().max(300, "La nota es muy larga").optional(),
  idempotencyKey: idempotencyKeySchema,
});

const BLIND_OPENING_NOTE = "Conteo a ciegas al abrir";

export async function openCashSessionAction(
  raw: z.input<typeof countInput>,
): Promise<ActionResult<{ sessionId: string; differenceLabel: string | null }>> {
  const staff = await requirePermission("cash.manage");
  return runAction(async () => {
    const input = countInput.parse(raw);
    const opened = await openCashSession(database(), {
      locationId: staff.locationId,
      counted: input.countedUnits,
      // A ciegas la nota no se exige: pedirla solo con diferencia diría si la base cuadra (MEDIUM-2).
      // La diferencia queda igual, a nombre de quien abre, y la base la marca si supera el umbral.
      note: input.note ?? (can(staff.role, "cash.review") ? undefined : BLIND_OPENING_NOTE),
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId },
      reopenClosedToday: can(staff.role, "day.reopen.today"),
    });
    refresh();
    return { sessionId: opened.sessionId.toString(), differenceLabel: opened.difference === 0n ? null : signedLabel(opened.difference) };
  });
}

export async function closeCashSessionAction(
  raw: z.input<typeof countInput>,
): Promise<ActionResult<{ expectedLabel: string; countedLabel: string; differenceLabel: string; needsReview: boolean }>> {
  const staff = await requirePermission("cash.manage");
  return runAction(async () => {
    const input = countInput.parse(raw);
    // Conteo a ciegas: la nota se pide SIEMPRE, antes de mirar el libro. Si solo se pidiera con
    // diferencia, el error "explica la diferencia" diría si el conteo cuadra y se podría tantear
    // el esperado (cerrar justo en él y esconder un faltante).
    if (!can(staff.role, "cash.review") && !input.note?.trim()) {
      throw new CashError("Escribe una nota del conteo: en el conteo a ciegas siempre se pide.");
    }
    const closed = await closeCashSession(database(), {
      locationId: staff.locationId,
      counted: input.countedUnits,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId },
    });
    refresh();
    return {
      expectedLabel: moneyLabel(closed.expected),
      countedLabel: moneyLabel(closed.counted),
      differenceLabel: signedLabel(closed.difference),
      needsReview: closed.needsReview,
    };
  });
}

const reviewInput = z.object({ sessionId: idSchema });

/** El dueño da por revisado un cierre marcado (diferencia mayor que el umbral de la sede). */
export async function markCashSessionReviewedAction(raw: z.input<typeof reviewInput>): Promise<ActionResult> {
  const staff = await requirePermission("cash.review");
  return runAction(async () => {
    const input = reviewInput.parse(raw);
    await markSessionReviewed(database(), { locationId: staff.locationId, sessionId: input.sessionId, actor: { userId: staff.userId } });
    refresh();
    return undefined;
  });
}

// ─── Movimientos ─────────────────────────────────────────────────────────────

const expenseInput = z.object({
  categoryId: idSchema,
  amountUnits: unitsSchema("El gasto"),
  paidFrom: z.enum(["cash", "bank"], "Elige si sale de la caja o del banco"),
  description: z.string().trim().min(3, "Describe el gasto (mínimo 3 caracteres)").max(200, "La descripción es muy larga"),
  idempotencyKey: idempotencyKeySchema,
});

export async function addExpenseAction(raw: z.input<typeof expenseInput>): Promise<ActionResult<{ expenseId: string }>> {
  // Gasto de caja: ledger.post (dueño y recepción). Gasto de banco: además expenses.bank (dueño).
  const staff = await requirePermission("ledger.post");
  // Se decide sobre la entrada YA validada (lo mismo que se va a guardar), no sobre el crudo.
  const parsed = expenseInput.safeParse(raw);
  if (parsed.success && parsed.data.paidFrom === "bank" && !can(staff.role, "expenses.bank")) {
    redirect("/panel?sin-permiso=1");
  }
  return runAction(async () => {
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;
    // Un gasto de banco no pasa por el conteo de la caja: confirmar identidad.
    if (input.paidFrom === "bank") requireRecentAuth(staff);
    const { expenseId } = await addExpense(database(), {
      locationId: staff.locationId,
      categoryId: input.categoryId,
      amount: input.amountUnits,
      paidFrom: input.paidFrom,
      description: input.description,
      idempotencyKey: input.idempotencyKey,
      // El rol baja a la base, que también exige expenses.bank para un gasto de banco.
      actor: { userId: staff.userId, role: staff.role },
    });
    refresh();
    return { expenseId: expenseId.toString() };
  });
}

const tipsInput = z.object({ staffId: idSchema, amountUnits: unitsSchema("El pago de propinas"), idempotencyKey: idempotencyKeySchema });

export async function payTipsAction(raw: z.input<typeof tipsInput>): Promise<ActionResult<{ movementId: string }>> {
  const staff = await requirePermission("cash.manage");
  return runAction(async () => {
    const input = tipsInput.parse(raw);
    const { movementId } = await payTips(database(), {
      locationId: staff.locationId,
      staffId: input.staffId,
      amount: input.amountUnits,
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId, role: staff.role },
    });
    refresh();
    return { movementId: movementId.toString() };
  });
}

const depositInput = z.object({ amountUnits: unitsSchema("La consignación"), idempotencyKey: idempotencyKeySchema });

export async function cashDepositAction(raw: z.input<typeof depositInput>): Promise<ActionResult<{ movementId: string }>> {
  const staff = await requirePermission("cash.manage");
  return runAction(async () => {
    const input = depositInput.parse(raw);
    const { movementId } = await cashDeposit(database(), {
      locationId: staff.locationId,
      amount: input.amountUnits,
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId, role: staff.role },
    });
    refresh();
    return { movementId: movementId.toString() };
  });
}

// ─── Cortesía (sprint 8, §4) ─────────────────────────────────────────────────

const courtesyInput = z.object({
  appointmentId: idSchema,
  // El dominio lo deja en una línea y exige de 3 a 300 caracteres; aquí solo se acota la entrada.
  reason: z.string().max(1000, "El motivo es muy largo"),
});

/**
 * Una cita de "Por cobrar" que el negocio regala: sin venta, sin asiento y sin comisión. Quien puede
 * dar descuentos (dueño; recepción si la sede lo habilita) y solo con el tope de descuento en 100 %.
 * Repetir devuelve la misma cortesía (una por cita).
 */
export async function giveCourtesyAction(raw: z.input<typeof courtesyInput>): Promise<ActionResult<{ created: boolean }>> {
  const staff = await requirePermission("ledger.post");
  // Como el gasto de banco: un permiso que depende de la regla de la sede se decide antes de actuar.
  if (!canDiscount(staff.role, await checkoutRulesOf(database(), staff.locationId))) redirect("/panel?sin-permiso=1");
  return runAction(async () => {
    const input = courtesyInput.parse(raw);
    const { created } = await giveCourtesy(database(), {
      locationId: staff.locationId,
      appointmentId: input.appointmentId,
      reason: input.reason,
      actor: { userId: staff.userId, role: staff.role, staffId: staff.staffId },
    });
    refresh();
    return { created };
  });
}

// ─── Día contable ────────────────────────────────────────────────────────────

const closeDayInput = z.object({ businessDate: dateSchema });

export async function closeDayAction(raw: z.input<typeof closeDayInput>): Promise<ActionResult> {
  const staff = await requirePermission("day.close");
  return runAction(async () => {
    const input = closeDayInput.parse(raw);
    await closeBusinessDay(database(), { locationId: staff.locationId, businessDate: input.businessDate, actor: { userId: staff.userId } });
    refresh();
    return undefined;
  });
}

const reopenDayInput = z.object({ businessDate: dateSchema, reason: z.string().max(300, "El motivo es muy largo") });

export async function reopenDayAction(raw: z.input<typeof reopenDayInput>): Promise<ActionResult> {
  const staff = await requirePermission("day.reopen");
  return runAction(async () => {
    // Reabrir un día es crítico: exige haber confirmado identidad hace poco.
    requireRecentAuth(staff);
    const input = reopenDayInput.parse(raw);
    await reopenBusinessDay(database(), {
      locationId: staff.locationId,
      businessDate: input.businessDate,
      reason: input.reason,
      actor: { userId: staff.userId },
    });
    refresh();
    return undefined;
  });
}

export interface CashHistoryView {
  period: HistoryPeriodView;
  sessions: {
    id: string;
    openedDate: string;
    openedTime: string;
    openedBy: string;
    openingCountedLabel: string;
    /** Diferencia de apertura con signo ("+$ 2.000", "-$ 500"); null si cuadró. */
    openingDifferenceLabel: string | null;
    openingShort: boolean;
    openingNote: string | null;
    closed: { date: string; time: string; by: string; expectedLabel: string; countedLabel: string; differenceLabel: string | null; short: boolean; note: string | null } | null;
    review: "none" | "pending" | "done";
    reviewedBy: string | null;
  }[];
  openingDifferenceLabel: string;
  closingDifferenceLabel: string;
}

const cashHistoryInput = z.object({ from: z.string().max(10).optional(), to: z.string().max(10).optional() });

/**
 * Histórico de caja del dueño: cada apertura y cierre del periodo con quién, a qué hora, base,
 * esperado, contado y diferencia. Solo cash.review: el esperado no se le muestra a quien cuenta a
 * ciegas (auditoría del sprint 4, MEDIUM-3).
 */
export async function loadCashHistory(raw: z.input<typeof cashHistoryInput>): Promise<ActionResult<CashHistoryView>> {
  const staff = await requirePermission("cash.review");
  return runAction(async () => {
    const input = cashHistoryInput.parse(raw);
    return readOnlySnapshot(database(), async (tx) => {
      const day = await today(tx, staff.locationId);
      const period = historyPeriod(day.businessDate, input.from, input.to);
      const data = await cashSessionsInPeriod(tx, { locationId: staff.locationId, from: period.from, to: period.to });
      const diff = (d: bigint) => (d === 0n ? null : signedLabel(d));
      return {
        period,
        sessions: data.sessions.map((s) => ({
          id: s.id.toString(),
          openedDate: s.openedDate,
          openedTime: s.openedTime,
          openedBy: s.openedBy,
          openingCountedLabel: moneyLabel(s.openingCounted),
          openingDifferenceLabel: diff(s.openingDifference),
          openingShort: s.openingDifference < 0n,
          openingNote: s.openingNote,
          closed:
            s.closedDate === null || s.expected === null || s.closingCounted === null || s.difference === null
              ? null
              : {
                  date: s.closedDate,
                  time: s.closedTime ?? "",
                  by: s.closedBy ?? "Personal",
                  expectedLabel: moneyLabel(s.expected),
                  countedLabel: moneyLabel(s.closingCounted),
                  differenceLabel: diff(s.difference),
                  short: s.difference < 0n,
                  note: s.closingNote,
                },
          review: !s.flagged ? "none" : s.reviewed ? "done" : "pending",
          reviewedBy: s.reviewedBy,
        })),
        openingDifferenceLabel: signedLabel(data.openingDifference),
        closingDifferenceLabel: signedLabel(data.closingDifference),
      };
    });
  });
}
