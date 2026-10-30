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
} from "@/db/cash";
import { db } from "@/db/client";
import { addExpense } from "@/db/expenses";
import type { Db } from "@/db/types";
import { CashError } from "@/domain/sales/cash";
import { can } from "@/domain/staff/roles";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { dateSchema, idempotencyKeySchema, unitsSchema } from "@/lib/action-schemas";
import { absLabel, atLabel, minorText, moneyLabel, signedLabel } from "@/lib/labels";
import { requirePermission, requireRecentAuth } from "@/lib/session";

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
      kind: "sale" | "expense" | "tip_payout" | "cash_deposit" | "cash_adjustment" | "reversal";
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
    opening: null | { atLabel: string; expectedLabel: string; countedLabel: string; differenceLabel: string; note: string | null };
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
  canBankExpense: boolean;
  canCloseDay: boolean;
  canReopenDay: boolean;
  daySales: {
    saleId: string;
    atLabel: string;
    clientName: string | null;
    totalLabel: string;
    status: "paid" | "voided";
    voidRequested: boolean;
    chargedBy: string;
  }[];
}

const BREAKDOWN: { kind: MovementKind; label: string; sign: "+" | "-" }[] = [
  { kind: "sale", label: "Ventas en efectivo (neto de cambio)", sign: "+" },
  { kind: "expense", label: "Gastos de caja", sign: "-" },
  { kind: "tip_payout", label: "Propinas pagadas en efectivo", sign: "-" },
  { kind: "cash_deposit", label: "Consignaciones", sign: "-" },
  { kind: "reversal", label: "Anulaciones", sign: "-" },
];

export async function loadCashView(): Promise<ActionResult<CashView>> {
  const staff = await requirePermission("ledger.post");
  return runAction(async () => {
    // Todo en UNA transacción REPEATABLE READ de solo lectura (L3): una sola foto del libro.
    const { day, summary, closed, owed, categories, sales, ledger, flagged } = await cashViewData(database(), staff.locationId);
    const tz = day.timeZone;
    const canReview = can(staff.role, "cash.review");
    const blind = !canReview;

    let session: CashView["session"] = null;
    if (summary) {
      const breakdown: NonNullable<CashView["session"]>["breakdown"] = [
        { label: "Base contada al abrir", amountLabel: moneyLabel(summary.openingCounted), sign: "+" },
      ];
      for (const b of BREAKDOWN) {
        const net = summary.byKind.get(b.kind) ?? 0n;
        if (net === 0n && b.kind !== "sale") continue;
        // Las ventas suman y lo demás resta; si una anulación o un ajuste va al revés, se muestra con ±.
        const natural = b.sign === "+" ? net >= 0n : net <= 0n;
        breakdown.push(natural ? { label: b.label, amountLabel: absLabel(net), sign: b.sign } : { label: b.label, amountLabel: signedLabel(net), sign: "±" });
      }
      if (summary.unexplained !== 0n) {
        breakdown.push({ label: "Otros movimientos del libro", amountLabel: signedLabel(summary.unexplained), sign: "±" });
      }
      session = {
        id: summary.id.toString(),
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
      expectedOpeningMinor: summary && blind ? null : minorText(ledger),
      expectedOpeningLabel: summary && blind ? null : moneyLabel(ledger),
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
      canBankExpense: can(staff.role, "expenses.bank"),
      canCloseDay: can(staff.role, "day.close"),
      canReopenDay: can(staff.role, "day.reopen"),
      daySales: sales.map((s) => ({
        saleId: s.saleId.toString(),
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

export async function openCashSessionAction(
  raw: z.input<typeof countInput>,
): Promise<ActionResult<{ sessionId: string; differenceLabel: string | null }>> {
  const staff = await requirePermission("cash.manage");
  return runAction(async () => {
    const input = countInput.parse(raw);
    const opened = await openCashSession(database(), {
      locationId: staff.locationId,
      counted: input.countedUnits,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId },
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
