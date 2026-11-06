"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { openSession, today } from "@/db/cash";
import { listExpenseCategories } from "@/db/checkout-settings";
import { db } from "@/db/client";
import {
  listRecurringExpenses,
  recurringPayMode,
  registerRecurringExpense,
  saveRecurringExpense,
  skipRecurringExpense,
} from "@/db/recurring-expenses";
import type { Db } from "@/db/types";
import { duePeriods, nextDueDate, periodLabel, RECURRING_PAY_MODES, scheduleLabel } from "@/domain/expenses/recurring";
import { PESO } from "@/domain/money";
import { sessionIsFromEarlierDay } from "@/domain/sales/cash";
import { can } from "@/domain/staff/roles";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { dateSchema, unitsSchema } from "@/lib/action-schemas";
import { moneyLabel } from "@/lib/labels";
import { requirePermission, requireRecentAuth } from "@/lib/session";
import { dayShort } from "../_components/dates";
import { dueItems, type RecurringDueItem, sortDue } from "./view";

// Gastos fijos (docs/sprint-8-gastos-controles.md §5). La sede sale SIEMPRE de la sesión.
// - Plantillas (ver, crear, editar): settings.manage (el dueño).
// - Registrar un periodo: de caja, ledger.post (dueño y recepción); de banco, además expenses.bank y
//   confirmar identidad, como el gasto de banco de Caja. El modo lo decide la plantilla, no el cliente.
// - Omitir un periodo: expenses.recurring.skip (solo el dueño).
// Nada se asienta solo: registrar es el gasto normal (src/db/recurring-expenses.ts).

const conn = () => db() as unknown as Db;

function refresh() {
  revalidatePath("/panel/gastos-fijos");
  revalidatePath("/panel/caja");
  revalidatePath("/panel/inicio");
}

export interface RecurringTemplateView {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  /** Pesos enteros (texto de dígitos) para el formulario, y su etiqueta. */
  estimatedUnits: string;
  estimatedLabel: string;
  payMode: "cash" | "bank";
  dayOfMonth: number;
  intervalMonths: number;
  startMonth: string;
  active: boolean;
  scheduleLabel: string;
  /** "Próximo: 5 dic" cuando no hay nada pendiente; null si está pausada. */
  nextDueLabel: string | null;
  /** "Octubre de 2026: registrado ($ 812.000)" / "…: omitido". */
  lastRunLabel: string | null;
  due: RecurringDueItem[];
}

export interface RecurringView {
  today: string;
  templates: RecurringTemplateView[];
  categories: { id: string; name: string }[];
  /** Registrar de caja: hace falta la caja de hoy abierta (el servidor lo vuelve a exigir). */
  cashOpen: boolean;
  canRegisterCash: boolean;
  canRegisterBank: boolean;
  canSkip: boolean;
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function loadRecurringExpenses(): Promise<ActionResult<RecurringView>> {
  const staff = await requirePermission("settings.manage");
  return runAction(async () => {
    const c = conn();
    const day = await today(c, staff.locationId);
    const [templates, categories, session] = await Promise.all([
      listRecurringExpenses(c, { locationId: staff.locationId }),
      listExpenseCategories(c, { locationId: staff.locationId, activeOnly: true }),
      openSession(c, staff.locationId),
    ]);
    return {
      today: day.businessDate,
      templates: templates.map((t) => {
        const due = t.active ? duePeriods(t, { today: day.businessDate, registeredOrSkipped: t.done }) : [];
        const next = nextDueDate(t, day.businessDate);
        return {
          id: t.id.toString(),
          name: t.name,
          categoryId: t.categoryId.toString(),
          categoryName: t.categoryName,
          estimatedUnits: (t.estimatedAmount / PESO).toString(),
          estimatedLabel: moneyLabel(t.estimatedAmount),
          payMode: t.payMode,
          dayOfMonth: t.dayOfMonth,
          intervalMonths: t.intervalMonths,
          startMonth: t.startMonth,
          active: t.active,
          scheduleLabel: scheduleLabel(t),
          nextDueLabel: next && due.length === 0 ? `Próximo: ${dayShort(next)}` : null,
          lastRunLabel: t.lastRun
            ? `${capitalized(periodLabel(t.lastRun.period))}: ${
                t.lastRun.outcome === "registered" ? `registrado${t.lastRun.amount !== null ? ` (${moneyLabel(t.lastRun.amount)})` : ""}` : "omitido"
              }`
            : null,
          due: sortDue(dueItems([{ template: t, due }])),
        };
      }),
      categories: categories.map((cat) => ({ id: cat.id.toString(), name: cat.name })),
      cashOpen: !!session && !sessionIsFromEarlierDay(session.businessDate, day.businessDate) && !day.closed,
      canRegisterCash: can(staff.role, "ledger.post"),
      canRegisterBank: can(staff.role, "expenses.bank"),
      canSkip: can(staff.role, "expenses.recurring.skip"),
    };
  });
}

const monthSchema = dateSchema.refine((v) => v.endsWith("-01"), "Elige el mes de inicio");

const templateInput = z.object({
  id: idSchema.optional(),
  name: z.string().max(60, "El nombre es muy largo (máximo 60 caracteres)"),
  categoryId: idSchema,
  estimatedUnits: unitsSchema("El monto estimado"),
  payMode: z.enum(RECURRING_PAY_MODES, "Elige si se paga de la caja o del banco"),
  dayOfMonth: z.number().int("El día de pago va del 1 al 28").min(1, "El día de pago va del 1 al 28").max(28, "El día de pago va del 1 al 28"),
  intervalMonths: z.number().int("Cada cuántos meses: de 1 a 12").min(1, "Cada cuántos meses: de 1 a 12").max(12, "Cada cuántos meses: de 1 a 12"),
  startMonth: monthSchema,
  active: z.boolean(),
});

export async function saveRecurringExpenseAction(raw: z.input<typeof templateInput>): Promise<ActionResult<{ id: string }>> {
  const staff = await requirePermission("settings.manage");
  return runAction(async () => {
    const input = templateInput.parse(raw);
    const { id } = await saveRecurringExpense(conn(), {
      locationId: staff.locationId,
      id: input.id,
      categoryId: input.categoryId,
      draft: {
        name: input.name,
        estimatedAmount: input.estimatedUnits,
        payMode: input.payMode,
        dayOfMonth: input.dayOfMonth,
        intervalMonths: input.intervalMonths,
        startMonth: input.startMonth,
        active: input.active,
      },
      actor: { userId: staff.userId, staffId: staff.staffId },
    });
    refresh();
    return { id: id.toString() };
  });
}

const registerInput = z.object({
  recurringId: idSchema,
  period: monthSchema,
  amountUnits: unitsSchema("El gasto"),
  description: z.string().trim().min(3, "Describe el gasto (mínimo 3 caracteres)").max(200, "La descripción es muy larga"),
});

export async function registerRecurringExpenseAction(raw: z.input<typeof registerInput>): Promise<ActionResult<{ expenseId: string; created: boolean }>> {
  // De caja: ledger.post (dueño y recepción). De banco: además expenses.bank (el dueño).
  const staff = await requirePermission("ledger.post");
  const parsed = registerInput.safeParse(raw);
  // El modo sale de la plantilla de ESTA sede (una de otra sede no existe aquí: falla adentro).
  const payMode = parsed.success ? await recurringPayMode(conn(), staff.locationId, parsed.data.recurringId) : null;
  if (payMode === "bank" && !can(staff.role, "expenses.bank")) redirect("/panel?sin-permiso=1");
  return runAction(async () => {
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;
    // Un gasto de banco no pasa por el conteo de la caja: confirmar identidad.
    if (payMode === "bank") requireRecentAuth(staff);
    const done = await registerRecurringExpense(conn(), {
      locationId: staff.locationId,
      recurringId: input.recurringId,
      period: input.period,
      amount: input.amountUnits,
      description: input.description,
      // Si la plantilla no existe, registerRecurringExpense lo dice; si cambió de modo, no registra.
      expectedPayMode: payMode ?? "cash",
      actor: { userId: staff.userId, role: staff.role, staffId: staff.staffId },
    });
    refresh();
    return { expenseId: done.expenseId.toString(), created: done.created };
  });
}

const skipInput = z.object({
  recurringId: idSchema,
  period: monthSchema,
  reason: z.string().trim().min(3, "Escribe por qué se omite (mínimo 3 caracteres)").max(300, "El motivo es muy largo"),
});

export async function skipRecurringExpenseAction(raw: z.input<typeof skipInput>): Promise<ActionResult<{ created: boolean }>> {
  const staff = await requirePermission("expenses.recurring.skip");
  return runAction(async () => {
    const input = skipInput.parse(raw);
    const done = await skipRecurringExpense(conn(), {
      locationId: staff.locationId,
      recurringId: input.recurringId,
      period: input.period,
      reason: input.reason,
      actor: { userId: staff.userId, role: staff.role, staffId: staff.staffId },
    });
    refresh();
    return done;
  });
}

