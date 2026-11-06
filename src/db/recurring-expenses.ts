import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { AuditValue } from "@/domain/audit/events";
import { AUDIT_FIELDS } from "@/domain/audit/events";
import {
  cleanLine,
  cleanSkipReason,
  type DuePeriod,
  duePeriods,
  isMonthStart,
  periodLabel,
  type RecurringDraft,
  RecurringExpenseError,
  type RecurringPayMode,
  recurringIdempotencyKey,
  validateRecurringDraft,
} from "@/domain/expenses/recurring";
import { businessDate } from "@/domain/ledger/business-date";
import { format, type Money } from "@/domain/money";
import { IdempotencyConflictError } from "@/domain/security/idempotency";
import { can, type Role } from "@/domain/staff/roles";
import { recordAudit, recordConfigChange } from "./audit";
import { today as todayOf } from "./cash";
import { addExpenseTx, MIN_EXPENSE_DESCRIPTION } from "./expenses";
import { expenseCategories, expenses, locations, recurringExpenseRuns, recurringExpenses } from "./schema";
import { serializable } from "./serializable";
import type { Db } from "./types";

// Gastos fijos (docs/sprint-8-gastos-controles.md §5). NADA se asienta solo: una plantilla solo dice
// qué periodos tocan (duePeriods, dominio puro) y alguien confirma cada uno:
// - registrar: un gasto NORMAL (addExpenseTx: caja abierta FOR UPDATE y efectivo suficiente si es de
//   caja, día abierto, expenses.bank si es de banco, su asiento y su expense.add) y su fila en
//   recurring_expense_runs y el evento recurring_expense.register, todo en UNA transacción
//   SERIALIZABLE con la clave recurring:<id>:<periodo>. Repetir no duplica ni el gasto ni el periodo.
// - omitir (solo el dueño): la fila con el motivo y el evento recurring_expense.skip.
// La plantilla se bloquea FOR UPDATE en las dos, así un registro y una omisión del mismo periodo (o
// una edición de la plantilla) se ponen en fila.

export interface RecurringActor {
  userId: string;
  role: Role;
  /** Para la bitácora; sin él se busca por el usuario en la sede. */
  staffId?: bigint;
}

export interface RecurringRow {
  id: bigint;
  name: string;
  categoryId: bigint;
  categoryName: string;
  categoryActive: boolean;
  estimatedAmount: bigint;
  payMode: RecurringPayMode;
  dayOfMonth: number;
  intervalMonths: number;
  startMonth: string;
  active: boolean;
  /** Periodos ya registrados u omitidos desde el mes de inicio (los anteriores no cuentan para duePeriods). */
  done: string[];
  /** El último periodo resuelto (registrado u omitido), si hay. */
  lastRun: null | { period: string; outcome: "registered" | "skipped"; amount: bigint | null };
}

const templateColumns = {
  id: recurringExpenses.id,
  name: recurringExpenses.name,
  categoryId: recurringExpenses.categoryId,
  estimatedAmount: recurringExpenses.estimatedAmount,
  payMode: recurringExpenses.payMode,
  dayOfMonth: recurringExpenses.dayOfMonth,
  intervalMonths: recurringExpenses.intervalMonths,
  startMonth: recurringExpenses.startMonth,
  active: recurringExpenses.active,
};

/** Las plantillas de la sede con sus periodos resueltos, por nombre. */
export async function listRecurringExpenses(db: Db, input: { locationId: bigint; payMode?: RecurringPayMode; activeOnly?: boolean }): Promise<RecurringRow[]> {
  const rows = await db
    .select({ ...templateColumns, categoryName: expenseCategories.name, categoryActive: expenseCategories.active })
    .from(recurringExpenses)
    .innerJoin(expenseCategories, and(eq(expenseCategories.locationId, recurringExpenses.locationId), eq(expenseCategories.id, recurringExpenses.categoryId)))
    .where(
      and(
        eq(recurringExpenses.locationId, input.locationId),
        input.payMode ? eq(recurringExpenses.payMode, input.payMode) : undefined,
        input.activeOnly ? eq(recurringExpenses.active, true) : undefined,
      ),
    )
    .orderBy(asc(recurringExpenses.name), asc(recurringExpenses.id));
  if (rows.length === 0) return [];
  // Solo los registros de las plantillas listadas y solo los periodos que importan: desde el mes de
  // inicio de cada plantilla (duePeriods no mira antes) más el último de cada una (lastRun), aunque
  // quede antes si el mes de inicio se movió. Así no se lee toda la historia de la sede.
  const latest = sql`(select max(r2.period) from recurring_expense_runs r2
                       where r2.location_id = ${recurringExpenseRuns.locationId} and r2.recurring_id = ${recurringExpenseRuns.recurringId})`;
  const runs = await db
    .select({ recurringId: recurringExpenseRuns.recurringId, period: recurringExpenseRuns.period, outcome: recurringExpenseRuns.outcome, amount: expenses.amount })
    .from(recurringExpenseRuns)
    .innerJoin(recurringExpenses, and(eq(recurringExpenses.locationId, recurringExpenseRuns.locationId), eq(recurringExpenses.id, recurringExpenseRuns.recurringId)))
    .leftJoin(expenses, and(eq(expenses.locationId, recurringExpenseRuns.locationId), eq(expenses.id, recurringExpenseRuns.expenseId)))
    .where(
      and(
        eq(recurringExpenseRuns.locationId, input.locationId),
        inArray(
          recurringExpenseRuns.recurringId,
          rows.map((r) => r.id),
        ),
        or(gte(recurringExpenseRuns.period, recurringExpenses.startMonth), eq(recurringExpenseRuns.period, latest)),
      ),
    )
    .orderBy(asc(recurringExpenseRuns.recurringId), desc(recurringExpenseRuns.period));
  const byTemplate = new Map<bigint, typeof runs>();
  for (const r of runs) {
    const list = byTemplate.get(r.recurringId) ?? [];
    list.push(r);
    byTemplate.set(r.recurringId, list);
  }
  return rows.map((r) => {
    const own = byTemplate.get(r.id) ?? [];
    const last = own[0];
    return {
      ...r,
      done: own.map((x) => x.period),
      lastRun: last ? { period: last.period, outcome: last.outcome, amount: last.amount } : null,
    };
  });
}

export interface DueRecurring {
  template: RecurringRow;
  due: DuePeriod[];
}

/** Lo vencido o por vencer de la sede (activas), con el día local de la sede. */
export async function dueRecurringExpenses(
  db: Db,
  input: { locationId: bigint; payMode?: RecurringPayMode; now?: Date },
): Promise<{ today: string; items: DueRecurring[] }> {
  const [loc] = await db.select({ timeZone: locations.timezone }).from(locations).where(eq(locations.id, input.locationId));
  if (!loc) throw new Error(`La sede ${input.locationId} no existe`);
  const today = businessDate(input.now ?? new Date(), loc.timeZone);
  const templates = await listRecurringExpenses(db, { locationId: input.locationId, payMode: input.payMode, activeOnly: true });
  const items = templates
    .map((template) => ({ template, due: duePeriods(template, { today, registeredOrSkipped: template.done }) }))
    .filter((x) => x.due.length > 0);
  return { today, items };
}

// ─── Plantillas ──────────────────────────────────────────────────────────────

const PAY_MODE_LABEL: Record<RecurringPayMode, string> = { cash: "Caja", bank: "Banco" };

/** Foto para la bitácora (FOR UPDATE): la categoría por su nombre y el dinero como texto de centavos. */
export async function recurringExpenseSnapshot(
  tx: Db,
  locationId: bigint,
  id: bigint,
): Promise<(Record<string, AuditValue> & { startMonth: string; categoryId: string }) | null> {
  const [row] = await tx
    .select({ ...templateColumns, category: expenseCategories.name })
    .from(recurringExpenses)
    .innerJoin(expenseCategories, and(eq(expenseCategories.locationId, recurringExpenses.locationId), eq(expenseCategories.id, recurringExpenses.categoryId)))
    .where(and(eq(recurringExpenses.locationId, locationId), eq(recurringExpenses.id, id)))
    .for("update", { of: recurringExpenses });
  if (!row) return null;
  return {
    name: row.name,
    // Fuera de la lista blanca (no entra a la bitácora): para saber si la categoría cambió.
    categoryId: row.categoryId.toString(),
    category: row.category,
    estimatedAmount: row.estimatedAmount.toString(),
    payMode: PAY_MODE_LABEL[row.payMode],
    dayOfMonth: String(row.dayOfMonth),
    intervalMonths: String(row.intervalMonths),
    startMonth: row.startMonth,
    active: row.active,
  };
}

export interface SaveRecurringInput {
  locationId: bigint;
  /** Sin id: plantilla nueva. */
  id?: bigint;
  categoryId: bigint;
  draft: RecurringDraft;
  actor: { userId: string; staffId?: bigint };
  now?: Date;
}

/** Crea o edita una plantilla, con su evento de configuración (antes y después) en la misma transacción. */
export async function saveRecurringExpense(db: Db, input: SaveRecurringInput): Promise<{ id: bigint }> {
  return serializable(db, async (tx) => {
    const day = await todayOf(tx, input.locationId, input.now);
    const before = input.id === undefined ? null : await recurringExpenseSnapshot(tx, input.locationId, input.id);
    if (input.id !== undefined && !before) throw new RecurringExpenseError("El gasto fijo no existe");
    const { name } = validateRecurringDraft(input.draft, { today: day.businessDate, previousStartMonth: before?.startMonth });

    const [category] = await tx
      .select({ id: expenseCategories.id, active: expenseCategories.active })
      .from(expenseCategories)
      .where(and(eq(expenseCategories.locationId, input.locationId), eq(expenseCategories.id, input.categoryId)));
    if (!category) throw new RecurringExpenseError("La categoría no existe");
    // Una categoría desactivada no se elige. Una plantilla que ya la tenía no puede quedar ACTIVA con
    // ella (su gasto se rechazaría al registrarlo), pero sí se puede pausar.
    if (!category.active) {
      if (before?.categoryId !== input.categoryId.toString()) throw new RecurringExpenseError("La categoría está desactivada");
      if (input.draft.active) throw new RecurringExpenseError("La categoría está desactivada: elige otra o pausa el gasto fijo");
    }

    const values = {
      name,
      categoryId: input.categoryId,
      estimatedAmount: input.draft.estimatedAmount.minor,
      payMode: input.draft.payMode,
      dayOfMonth: input.draft.dayOfMonth,
      intervalMonths: input.draft.intervalMonths,
      startMonth: input.draft.startMonth,
      active: input.draft.active,
    };
    let id: bigint;
    if (input.id === undefined) {
      const [row] = await tx
        .insert(recurringExpenses)
        .values({ ...values, locationId: input.locationId, createdBy: input.actor.userId })
        .returning({ id: recurringExpenses.id });
      id = row!.id;
    } else {
      id = input.id;
      await tx
        .update(recurringExpenses)
        .set({ ...values, updatedAt: sql`now()` })
        .where(and(eq(recurringExpenses.locationId, input.locationId), eq(recurringExpenses.id, id)));
    }
    const after = await recurringExpenseSnapshot(tx, input.locationId, id);
    await recordConfigChange(
      tx,
      {
        locationId: input.locationId,
        actorUserId: input.actor.userId,
        actorStaffId: input.actor.staffId,
        action: "recurring_expense.save",
        targetKind: "recurring_expense",
        targetRef: id.toString(),
        summary: `${before ? "Cambió" : "Creó"} el gasto fijo ${name}`,
      },
      before ?? {},
      after!,
      AUDIT_FIELDS.recurringExpense,
    );
    return { id };
  });
}

// ─── Registrar y omitir un periodo ───────────────────────────────────────────

async function lockTemplate(tx: Db, locationId: bigint, id: bigint) {
  const [row] = await tx
    .select(templateColumns)
    .from(recurringExpenses)
    .where(and(eq(recurringExpenses.locationId, locationId), eq(recurringExpenses.id, id)))
    .for("update");
  if (!row) throw new RecurringExpenseError("El gasto fijo no existe");
  return row;
}

async function runsOf(tx: Db, locationId: bigint, recurringId: bigint) {
  return tx
    .select({ period: recurringExpenseRuns.period, outcome: recurringExpenseRuns.outcome, expenseId: recurringExpenseRuns.expenseId, skipReason: recurringExpenseRuns.skipReason })
    .from(recurringExpenseRuns)
    .where(and(eq(recurringExpenseRuns.locationId, locationId), eq(recurringExpenseRuns.recurringId, recurringId)));
}

/** El periodo debe estar en la lista de lo que toca hoy (vencido o a lo sumo 3 días antes). */
function assertDue(template: Awaited<ReturnType<typeof lockTemplate>>, period: string, today: string, done: string[]) {
  if (!template.active) throw new RecurringExpenseError("El gasto fijo está pausado");
  if (!duePeriods(template, { today, registeredOrSkipped: done }).some((d) => d.period === period)) {
    throw new RecurringExpenseError("Ese periodo todavía no toca o no es de este gasto fijo");
  }
}

export interface RegisterRecurringInput {
  locationId: bigint;
  recurringId: bigint;
  /** Primer día del mes del periodo. */
  period: string;
  /** Lo que realmente se pagó (los servicios públicos varían): se puede cambiar el estimado. */
  amount: Money;
  description: string;
  /**
   * El modo que la acción vio al verificar permisos (y la reautenticación del banco). Si la plantilla
   * cambió entre tanto, no se registra: el permiso se decidió sobre otro modo.
   */
  expectedPayMode: RecurringPayMode;
  actor: RecurringActor;
  now?: Date;
}

/**
 * Registra el pago de un periodo: un gasto normal de la categoría y el modo de la plantilla, más su
 * fila en recurring_expense_runs y el evento, en UNA transacción. Repetir lo mismo devuelve el mismo
 * gasto (created: false); otro monto o descripción para un periodo ya registrado, o un periodo
 * omitido, se rechaza.
 */
export async function registerRecurringExpense(db: Db, input: RegisterRecurringInput): Promise<{ expenseId: bigint; created: boolean }> {
  if (!isMonthStart(input.period)) throw new RecurringExpenseError("Periodo inválido");
  const description = cleanLine(input.description);
  if (description.length < MIN_EXPENSE_DESCRIPTION) throw new RecurringExpenseError("Describe el gasto (mínimo 3 caracteres)");
  const idempotencyKey = recurringIdempotencyKey(input.recurringId, input.period);
  return serializable(db, async (tx) => {
    const template = await lockTemplate(tx, input.locationId, input.recurringId);
    if (template.payMode !== input.expectedPayMode) throw new RecurringExpenseError("El gasto fijo cambió mientras lo registrabas. Recarga la pantalla.");
    const expense = {
      locationId: input.locationId,
      categoryId: template.categoryId,
      amount: input.amount,
      paidFrom: template.payMode,
      description,
      idempotencyKey,
      actor: input.actor,
      now: input.now,
    };
    const runs = await runsOf(tx, input.locationId, template.id);
    const run = runs.find((r) => r.period === input.period);
    if (run) {
      if (run.outcome === "skipped") throw new RecurringExpenseError(`El gasto fijo de ${periodLabel(input.period)} ya se omitió`);
      // Ya registrado: la misma solicitud (reintento) devuelve el mismo gasto; otra, se rechaza.
      try {
        const same = await addExpenseTx(tx, expense);
        if (same.created || same.expenseId !== run.expenseId) throw new Error(`gasto fijo ${template.id} ${input.period}: el gasto no coincide con su registro`);
        return same;
      } catch (err) {
        if (err instanceof IdempotencyConflictError) throw new RecurringExpenseError(`El gasto fijo de ${periodLabel(input.period)} ya se registró`);
        throw err;
      }
    }
    const day = await todayOf(tx, input.locationId, input.now);
    assertDue(template, input.period, day.businessDate, runs.map((r) => r.period));

    const created = await addExpenseTx(tx, expense);
    // Un gasto con esta clave sin su registro no puede existir (se crean juntos): sería un error del sistema.
    if (!created.created) throw new Error(`gasto fijo ${template.id} ${input.period}: el gasto ya existía sin su registro`);
    await tx.insert(recurringExpenseRuns).values({
      locationId: input.locationId,
      recurringId: template.id,
      period: input.period,
      outcome: "registered",
      expenseId: created.expenseId,
      createdBy: input.actor.userId,
    });
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      actorStaffId: input.actor.staffId,
      action: "recurring_expense.register",
      targetKind: "recurring_expense",
      targetRef: template.id.toString(),
      summary: `Registró el gasto fijo ${template.name} de ${periodLabel(input.period)}: ${format(input.amount)}, pagado ${template.payMode === "cash" ? "de la caja" : "del banco"}`,
    });
    return created;
  });
}

export interface SkipRecurringInput {
  locationId: bigint;
  recurringId: bigint;
  period: string;
  reason: string;
  actor: RecurringActor;
  now?: Date;
}

/** Omite un periodo con su motivo (solo el dueño). Repetir con el mismo motivo no duplica. */
export async function skipRecurringExpense(db: Db, input: SkipRecurringInput): Promise<{ created: boolean }> {
  // El permiso se vuelve a exigir aquí (la acción ya lo verificó).
  if (!can(input.actor.role, "expenses.recurring.skip")) throw new RecurringExpenseError("Solo el dueño omite un gasto fijo");
  if (!isMonthStart(input.period)) throw new RecurringExpenseError("Periodo inválido");
  const reason = cleanSkipReason(input.reason);
  return serializable(db, async (tx) => {
    const template = await lockTemplate(tx, input.locationId, input.recurringId);
    const runs = await runsOf(tx, input.locationId, template.id);
    const run = runs.find((r) => r.period === input.period);
    if (run) {
      if (run.outcome === "skipped" && run.skipReason === reason) return { created: false };
      throw new RecurringExpenseError(`El gasto fijo de ${periodLabel(input.period)} ya se ${run.outcome === "skipped" ? "omitió" : "registró"}`);
    }
    const day = await todayOf(tx, input.locationId, input.now);
    assertDue(template, input.period, day.businessDate, runs.map((r) => r.period));
    await tx.insert(recurringExpenseRuns).values({
      locationId: input.locationId,
      recurringId: template.id,
      period: input.period,
      outcome: "skipped",
      skipReason: reason,
      createdBy: input.actor.userId,
    });
    // El motivo es texto libre: se queda en recurring_expense_runs, no en la bitácora.
    await recordAudit(tx, {
      locationId: input.locationId,
      actorUserId: input.actor.userId,
      actorStaffId: input.actor.staffId,
      action: "recurring_expense.skip",
      targetKind: "recurring_expense",
      targetRef: template.id.toString(),
      summary: `Omitió el gasto fijo ${template.name} de ${periodLabel(input.period)}`,
    });
    return { created: true };
  });
}

/** El modo de pago de una plantilla de la sede (para decidir el permiso antes de registrar). null si no existe. */
export async function recurringPayMode(db: Db, locationId: bigint, id: bigint): Promise<RecurringPayMode | null> {
  const [row] = await db
    .select({ payMode: recurringExpenses.payMode })
    .from(recurringExpenses)
    .where(and(eq(recurringExpenses.locationId, locationId), eq(recurringExpenses.id, id)));
  return row?.payMode ?? null;
}
