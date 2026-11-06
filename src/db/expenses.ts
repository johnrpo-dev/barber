import { and, eq } from "drizzle-orm";
import { CashError, expenseEntry } from "@/domain/sales/cash";
import { RECURRING_KEY_PREFIX } from "@/domain/expenses/recurring";
import { format, type Money } from "@/domain/money";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import { can, type Role } from "@/domain/staff/roles";
import { recordAudit } from "./audit";
import { type ActorRef, cashShortError, ledgerCash, requireOpenDay, requireOpenSession } from "./cash";
import { postEntry } from "./ledger";
import { cashMovements, expenseCategories, expenses } from "./schema";
import { serializable } from "./serializable";
import type { Db } from "./types";

// Gastos (docs/sprint-4-cobro-caja.md §3): de caja (exige la caja abierta y nunca deja la caja en
// negativo) o de banco. Una transacción SERIALIZABLE con su clave de idempotencia y su asiento.
// addExpenseTx es el mismo gasto dentro de una transacción ajena (gastos fijos, sprint 8).

export const MIN_EXPENSE_DESCRIPTION = 3;

export interface AddExpenseInput {
  locationId: bigint;
  categoryId: bigint;
  amount: Money;
  paidFrom: "cash" | "bank";
  description: string;
  idempotencyKey: string;
  /** Con su rol: la base también exige expenses.bank para un gasto de banco (no solo la acción). */
  actor: ActorRef & { role: Role };
  now?: Date;
}

/** Un gasto en su propia transacción SERIALIZABLE (con reintento). Comportamiento de siempre. */
export async function addExpense(db: Db, input: AddExpenseInput): Promise<{ expenseId: bigint; created: boolean }> {
  // La clave recurring:<id>:<periodo> es de los gastos fijos (src/db/recurring-expenses.ts): un gasto
  // suelto no puede "ocupar" el periodo de una plantilla.
  if (input.idempotencyKey.startsWith(RECURRING_KEY_PREFIX)) throw new CashError("Esa clave está reservada para los gastos fijos");
  return serializable(db, (tx) => addExpenseTx(tx, input));
}

/**
 * El gasto DENTRO de una transacción SERIALIZABLE abierta por quien llama (docs/sprint-8 §5: el gasto
 * de un periodo de un gasto fijo y su fila en recurring_expense_runs van en la misma). Valida, toma la
 * caja FOR UPDATE si es de efectivo, exige el día abierto y el efectivo suficiente, asienta y audita.
 * Una repetición con la misma clave devuelve el gasto que ya existe (created: false).
 */
export async function addExpenseTx(tx: Db, input: AddExpenseInput): Promise<{ expenseId: bigint; created: boolean }> {
  if (input.paidFrom === "bank" && !can(input.actor.role, "expenses.bank")) throw new CashError("Solo el dueño registra gastos pagados del banco");
  const description = input.description.trim();
  if (description.length < MIN_EXPENSE_DESCRIPTION) throw new CashError("Describe el gasto (mínimo 3 caracteres)");
  if (description.length > 200) throw new CashError("La descripción del gasto es muy larga");
  if (input.amount.minor <= 0n) throw new CashError("El gasto debe ser mayor que cero");
  if (input.amount.minor % 100n !== 0n) throw new CashError("El gasto debe ir en pesos enteros");
  if (input.amount.minor > 10n ** 13n) throw new CashError("El gasto es demasiado grande");
  const hash = requestHash({
    kind: "expense",
    locationId: input.locationId,
    categoryId: input.categoryId,
    amount: input.amount.minor,
    paidFrom: input.paidFrom,
    description,
    by: input.actor.userId,
  });
  const [existing] = await tx
    .select({ id: expenses.id, requestHash: expenses.requestHash })
    .from(expenses)
    .where(and(eq(expenses.locationId, input.locationId), eq(expenses.idempotencyKey, input.idempotencyKey)));
  if (existing) {
    assertSameRequest(existing, hash);
    return { expenseId: existing.id, created: false };
  }
  const [category] = await tx
    .select({ name: expenseCategories.name, accountCode: expenseCategories.accountCode })
    .from(expenseCategories)
    .where(and(eq(expenseCategories.locationId, input.locationId), eq(expenseCategories.id, input.categoryId), eq(expenseCategories.active, true)));
  if (!category) throw new CashError("La categoría del gasto no existe o está desactivada");
  const session = input.paidFrom === "cash" ? await requireOpenSession(tx, input.locationId, "Abre la caja para registrar un gasto de caja", input.now) : null;
  const day = await requireOpenDay(tx, input.locationId, input.now ?? new Date(), (m) => new CashError(m));
  if (session && input.amount.minor > (await ledgerCash(tx, input.locationId))) throw cashShortError(input.actor);

  const memo = `${category.name}: ${description}`.slice(0, 300);
  const posted = await postEntry(tx, {
    locationId: input.locationId,
    createdBy: input.actor.userId,
    entry: expenseEntry(
      { amount: input.amount, expenseAccount: category.accountCode, paidFrom: input.paidFrom },
      { businessDate: day, memo, idempotencyKey: `expense:${input.idempotencyKey}` },
    ),
  });
  const [row] = await tx
    .insert(expenses)
    .values({
      locationId: input.locationId,
      categoryId: input.categoryId,
      amount: input.amount.minor,
      paidFrom: input.paidFrom,
      cashSessionId: session?.id ?? null,
      description,
      businessDate: day,
      journalEntryId: posted.entryId,
      createdBy: input.actor.userId,
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
    })
    .returning({ id: expenses.id });
  if (session) {
    await tx.insert(cashMovements).values({
      locationId: input.locationId,
      cashSessionId: session.id,
      kind: "expense",
      journalEntryId: posted.entryId,
      description: memo.slice(0, 200),
      createdBy: input.actor.userId,
    });
  }
  // La categoría y el monto; la descripción es texto libre y no entra a la bitácora.
  await recordAudit(tx, {
    locationId: input.locationId,
    actorUserId: input.actor.userId,
    action: "expense.add",
    targetKind: "expense",
    targetRef: row!.id.toString(),
    summary: `Registró un gasto de ${format(input.amount)} en ${category.name}, pagado ${input.paidFrom === "cash" ? "de la caja" : "del banco"}`,
  });
  return { expenseId: row!.id, created: true };
}
