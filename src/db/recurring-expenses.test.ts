import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/domain/booking/clock";
import { periodOf, type RecurringPayMode } from "@/domain/expenses/recurring";
import { CHART_OF_ACCOUNTS } from "@/domain/ledger/accounts";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import { CashError, isExpenseCategoryAccount } from "@/domain/sales/cash";
import { closeBusinessDay, openCashSession } from "./cash";
import { listExpenseCategories, saveExpenseCategory } from "./checkout-settings";
import { addExpense } from "./expenses";
import {
  dueRecurringExpenses,
  listRecurringExpenses,
  registerRecurringExpense,
  saveRecurringExpense,
  skipRecurringExpense,
} from "./recurring-expenses";
import { expensesByCategory } from "./reports";
import { key, setupShop, TZ, type Shop } from "./sales-testing";
import { cashMovements, expenses, recurringExpenseRuns } from "./schema";
import { createTestDb } from "./testing";
import type { Db } from "./types";

// Gastos fijos (docs/sprint-8-gastos-controles.md §5). Nada se asienta solo: registrar un periodo es un
// gasto normal (con todas sus reglas) más su fila en recurring_expense_runs, en UNA transacción, con la
// clave recurring:<id>:<periodo>. Corre como villa_app, como en producción.

let db: Db;
let client: PGlite;
let shop: Shop;
let other: Shop;
/** Hora fija de la prueba: el día contable no cambia aunque la prueba cruce la medianoche. */
const NOW = new Date();
const TODAY = businessDate(NOW, TZ);
const THIS_PERIOD = periodOf(TODAY);
/** El día de pago que hace que el periodo de este mes ya toque (vence hoy o venció). */
const DUE_DAY = Math.min(Number(TODAY.slice(8, 10)), 28);

async function one<T>(sqlText: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sqlText, params);
  return rows[0]!;
}
const count = async (sqlText: string, params: unknown[]) => Number((await one<{ n: string }>(sqlText, params)).n);
const auditCount = (s: Shop, action: string) => count(`select count(*)::text as n from audit_events where location_id = $1 and action = $2`, [String(s.locationId), action]);
const journalCount = (s: Shop) => count(`select count(*)::text as n from journal_entries where location_id = $1`, [String(s.locationId)]);
const runCount = (s: Shop) => count(`select count(*)::text as n from recurring_expense_runs where location_id = $1`, [String(s.locationId)]);
const expenseCount = (s: Shop) => count(`select count(*)::text as n from expenses where location_id = $1`, [String(s.locationId)]);
const err = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

async function template(
  s: Shop,
  opts: { payMode?: RecurringPayMode; startMonth?: string; dayOfMonth?: number; intervalMonths?: number; units?: bigint; name?: string } = {},
): Promise<bigint> {
  const { id } = await saveRecurringExpense(db, {
    locationId: s.locationId,
    categoryId: s.category,
    draft: {
      name: opts.name ?? `Arriendo ${key()}`.slice(0, 40),
      estimatedAmount: fromUnits(opts.units ?? 800_000n),
      payMode: opts.payMode ?? "bank",
      dayOfMonth: opts.dayOfMonth ?? DUE_DAY,
      intervalMonths: opts.intervalMonths ?? 1,
      startMonth: opts.startMonth ?? THIS_PERIOD,
      active: true,
    },
    actor: { userId: s.owner.userId, staffId: s.owner.staffId },
    now: NOW,
  });
  return id;
}

const register = (s: Shop, recurringId: bigint, opts: { period?: string; units?: bigint; payMode?: RecurringPayMode; actor?: Shop["owner"] | Shop["reception"]; now?: Date; description?: string } = {}) =>
  registerRecurringExpense(db, {
    locationId: s.locationId,
    recurringId,
    period: opts.period ?? THIS_PERIOD,
    amount: fromUnits(opts.units ?? 812_000n),
    description: opts.description ?? "Arriendo del local",
    expectedPayMode: opts.payMode ?? "bank",
    actor: opts.actor ?? s.owner,
    now: opts.now ?? NOW,
  });

const skip = (s: Shop, recurringId: bigint, opts: { period?: string; reason?: string; actor?: Shop["owner"] | Shop["reception"]; now?: Date } = {}) =>
  skipRecurringExpense(db, {
    locationId: s.locationId,
    recurringId,
    period: opts.period ?? THIS_PERIOD,
    reason: opts.reason ?? "Se pagó por adelantado en efectivo del dueño",
    actor: opts.actor ?? s.owner,
    now: opts.now ?? NOW,
  });

beforeAll(async () => {
  ({ db, client } = await createTestDb({ role: "app" }));
  shop = await setupShop(db, "Gastos fijos");
  other = await setupShop(db, "Otra sede");
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("plantillas", () => {
  it("crear y editar deja la bitácora con el antes y el después; la categoría va por su nombre", async () => {
    const before = await auditCount(shop, "recurring_expense.save");
    const id = await template(shop, { name: "Internet del local", units: 120_000n });
    await saveRecurringExpense(db, {
      locationId: shop.locationId,
      id,
      categoryId: shop.category,
      draft: { name: "Internet", estimatedAmount: fromUnits(130_000n), payMode: "bank", dayOfMonth: 10, intervalMonths: 1, startMonth: THIS_PERIOD, active: true },
      actor: { userId: shop.owner.userId },
      now: NOW,
    });
    expect(await auditCount(shop, "recurring_expense.save")).toBe(before + 2);
    const { changes } = await one<{ changes: { field: string; before: string | null; after: string | null }[] }>(
      `select changes from audit_events where location_id = $1 and action = 'recurring_expense.save' order by id desc limit 1`,
      [String(shop.locationId)],
    );
    expect(changes).toEqual([
      { field: "name", before: "Internet del local", after: "Internet" },
      { field: "estimatedAmount", before: "12000000", after: "13000000" },
      { field: "dayOfMonth", before: String(DUE_DAY), after: "10" },
    ].filter((c) => c.before !== c.after));
    const first = await one<{ changes: { field: string; after: string }[] }>(
      `select changes from audit_events where location_id = $1 and action = 'recurring_expense.save' and target_ref = $2 order by id limit 1`,
      [String(shop.locationId), String(id)],
    );
    expect(first.changes.find((c) => c.field === "category")?.after).toBe("Insumos");
  });

  it("valida el nombre, el monto, el día y el mes de inicio", async () => {
    const base = { name: "Agua", estimatedAmount: fromUnits(50_000n), payMode: "bank" as const, dayOfMonth: 5, intervalMonths: 1, startMonth: THIS_PERIOD, active: true };
    const save = (draft: Partial<typeof base>) =>
      saveRecurringExpense(db, { locationId: shop.locationId, categoryId: shop.category, draft: { ...base, ...draft }, actor: { userId: "u" }, now: NOW });
    expect(await err(save({ name: "A" }))).toMatch(/nombre/);
    expect(await err(save({ dayOfMonth: 31 }))).toMatch(/1 al 28/);
    expect(await err(save({ estimatedAmount: { minor: 150n } as never }))).toMatch(/pesos enteros/);
    expect(await err(save({ startMonth: addDays(THIS_PERIOD, 500).slice(0, 8) + "01" }))).toMatch(/12 meses/);
  });

  it("no usa la categoría de otra sede ni edita la plantilla de otra sede", async () => {
    expect(
      await err(
        saveRecurringExpense(db, {
          locationId: shop.locationId,
          categoryId: other.category,
          draft: { name: "Agua", estimatedAmount: fromUnits(50_000n), payMode: "bank", dayOfMonth: 5, intervalMonths: 1, startMonth: THIS_PERIOD, active: true },
          actor: { userId: "u" },
          now: NOW,
        }),
      ),
    ).toMatch(/categoría no existe/);
    const theirs = await template(other);
    expect(
      await err(
        saveRecurringExpense(db, {
          locationId: shop.locationId,
          id: theirs,
          categoryId: shop.category,
          draft: { name: "Hackeada", estimatedAmount: fromUnits(1_000n), payMode: "bank", dayOfMonth: 5, intervalMonths: 1, startMonth: THIS_PERIOD, active: false },
          actor: { userId: "u" },
          now: NOW,
        }),
      ),
    ).toMatch(/no existe/);
  });

  it("la app edita solo las columnas de la plantilla y nunca la borra", async () => {
    const id = String(await template(shop));
    expect(await err(client.query(`update recurring_expenses set location_id = location_id where id = $1`, [id]))).toMatch(/permission denied/);
    expect(await err(client.query(`update recurring_expenses set created_by = 'x' where id = $1`, [id]))).toMatch(/permission denied/);
    expect(await err(client.query(`delete from recurring_expenses where id = $1`, [id]))).toMatch(/permission denied/);
    expect(await err(client.query(`update recurring_expenses set active = false where id = $1`, [id]))).toBe("ok");
  });
});

describe("registrar un periodo", () => {
  it("es un gasto normal de banco más su registro y su evento, en una transacción; repetir no duplica", async () => {
    const id = await template(shop);
    const counts = async () => ({
      expenses: await expenseCount(shop),
      runs: await runCount(shop),
      journal: await journalCount(shop),
      add: await auditCount(shop, "expense.add"),
      register: await auditCount(shop, "recurring_expense.register"),
    });
    const before = await counts();
    const done = await register(shop, id);
    expect(done.created).toBe(true);
    expect(await counts()).toEqual({
      expenses: before.expenses + 1,
      runs: before.runs + 1,
      journal: before.journal + 1,
      add: before.add + 1,
      register: before.register + 1,
    });
    const [expense] = await db.select().from(expenses).where(eq(expenses.id, done.expenseId));
    // El monto editado (no el estimado), de la categoría y el modo de la plantilla.
    expect(expense).toMatchObject({ amount: 81_200_000n, paidFrom: "bank", categoryId: shop.category, idempotencyKey: `recurring:${id}:${THIS_PERIOD}` });
    const [run] = await db.select().from(recurringExpenseRuns).where(eq(recurringExpenseRuns.recurringId, id));
    expect(run).toMatchObject({ period: THIS_PERIOD, outcome: "registered", expenseId: done.expenseId, skipReason: null });

    // Reintento idéntico: el mismo gasto, nada nuevo.
    const after = await counts();
    expect(await register(shop, id)).toEqual({ expenseId: done.expenseId, created: false });
    expect(await counts()).toEqual(after);
    // Otro monto para el mismo periodo: se rechaza, sin tocar nada.
    expect(await err(register(shop, id, { units: 900_000n }))).toMatch(/ya se registró/);
    expect(await err(skip(shop, id))).toMatch(/ya se registró/);
    expect(await counts()).toEqual(after);
    // Ya no aparece como pendiente.
    const due = await dueRecurringExpenses(db, { locationId: shop.locationId, now: NOW });
    expect(due.items.some((x) => x.template.id === id)).toBe(false);
  });

  it("de banco: recepción no lo registra aunque llegue directo a la base, y no queda nada", async () => {
    const id = await template(shop);
    const before = { expenses: await expenseCount(shop), runs: await runCount(shop) };
    await expect(register(shop, id, { actor: shop.reception })).rejects.toThrow(CashError);
    expect({ expenses: await expenseCount(shop), runs: await runCount(shop) }).toEqual(before);
  });

  it("de caja: exige la caja abierta y el efectivo suficiente; si falla, no queda ni el gasto ni el registro", async () => {
    const s = await setupShop(db, "Caja fija");
    const id = await template(s, { payMode: "cash", units: 300_000n });
    expect(await err(register(s, id, { payMode: "cash", units: 300_000n }))).toMatch(/Abre la caja/);
    await openCashSession(db, { locationId: s.locationId, counted: fromUnits(200_000n), note: "Base inicial de prueba", idempotencyKey: key("open"), actor: s.owner, now: NOW });
    expect(await err(register(s, id, { payMode: "cash", units: 300_000n }))).toMatch(/efectivo/i);
    expect({ expenses: await expenseCount(s), runs: await runCount(s) }).toEqual({ expenses: 0, runs: 0 });
    // Con lo que hay, sí: sale de la caja (movimiento del turno) y queda el registro.
    const done = await register(s, id, { payMode: "cash", units: 150_000n, actor: s.reception });
    expect(done.created).toBe(true);
    expect(await db.select({ kind: cashMovements.kind }).from(cashMovements).where(eq(cashMovements.locationId, s.locationId))).toEqual([{ kind: "expense" }]);
    expect(await runCount(s)).toBe(1);
  });

  it("si la plantilla cambió de modo entre la verificación y el registro, no se registra", async () => {
    const id = await template(shop, { payMode: "bank" });
    expect(await err(register(shop, id, { payMode: "cash" }))).toMatch(/cambió/);
  });

  it("solo periodos que ya tocan: ni futuros (más de 3 días), ni antes del inicio, ni fuera del intervalo", async () => {
    const id = await template(shop, { startMonth: periodOf(addDays(TODAY, -70)), intervalMonths: 2, dayOfMonth: 1 });
    const start = periodOf(addDays(TODAY, -70));
    const nextYear = `${Number(TODAY.slice(0, 4)) + 1}${THIS_PERIOD.slice(4)}`;
    const beforeStart = periodOf(addDays(start, -1));
    const offInterval = periodOf(addDays(start, 40));
    for (const period of [nextYear, beforeStart, offInterval]) expect(await err(register(shop, id, { period }))).toMatch(/no toca/);
    expect(await err(register(shop, id, { period: addDays(start, 1) }))).toMatch(/Periodo inválido/);
    expect(await register(shop, id, { period: start })).toMatchObject({ created: true });
  });

  it("no alcanza la plantilla de otra sede", async () => {
    const theirs = await template(other);
    const before = await expenseCount(shop);
    expect(await err(register(shop, theirs))).toMatch(/no existe/);
    expect(await err(skip(shop, theirs))).toMatch(/no existe/);
    expect(await expenseCount(shop)).toBe(before);
  });

  it("no entra en un día cerrado", async () => {
    const past = new Date(NOW.getTime() - 40 * 86_400_000);
    const pastDay = businessDate(past, TZ);
    const id = await template(shop, { startMonth: periodOf(pastDay), dayOfMonth: 1 });
    await closeBusinessDay(db, { locationId: shop.locationId, businessDate: pastDay, actor: { userId: "seed" } });
    expect(await err(register(shop, id, { period: periodOf(pastDay), now: past }))).toMatch(/cerrado/);
    expect(await db.select().from(recurringExpenseRuns).where(eq(recurringExpenseRuns.recurringId, id))).toEqual([]);
  });

  it("un gasto suelto no puede usar la clave de un periodo", async () => {
    await expect(
      addExpense(db, {
        locationId: shop.locationId,
        categoryId: shop.category,
        amount: fromUnits(1_000n),
        paidFrom: "bank",
        description: "Intento",
        idempotencyKey: `recurring:1:${THIS_PERIOD}`,
        actor: shop.owner,
      }),
    ).rejects.toThrow(new CashError("Esa clave está reservada para los gastos fijos"));
  });
});

describe("omitir un periodo", () => {
  it("solo el dueño, con motivo; repetir no duplica y ya no se puede registrar", async () => {
    const id = await template(shop);
    expect(await err(skip(shop, id, { actor: shop.reception }))).toMatch(/Solo el dueño/);
    expect(await err(skip(shop, id, { reason: "no" }))).toMatch(/motivo|mínimo/);
    const before = await auditCount(shop, "recurring_expense.skip");
    expect(await skip(shop, id)).toEqual({ created: true });
    expect(await skip(shop, id)).toEqual({ created: false });
    expect(await auditCount(shop, "recurring_expense.skip")).toBe(before + 1);
    expect(await err(skip(shop, id, { reason: "Otro motivo distinto" }))).toMatch(/ya se omitió/);
    expect(await err(register(shop, id))).toMatch(/ya se omitió/);
    const [run] = await db.select().from(recurringExpenseRuns).where(and(eq(recurringExpenseRuns.recurringId, id), eq(recurringExpenseRuns.period, THIS_PERIOD)));
    expect(run).toMatchObject({ outcome: "skipped", expenseId: null, skipReason: "Se pagó por adelantado en efectivo del dueño" });
  });

  it("recurring_expense_runs es solo-inserción y la base exige gasto o motivo", async () => {
    const id = await template(shop);
    await skip(shop, id);
    expect(await err(client.query(`update recurring_expense_runs set skip_reason = 'Cambiado' where recurring_id = $1`, [String(id)]))).toMatch(/permission denied/);
    expect(await err(client.query(`delete from recurring_expense_runs where recurring_id = $1`, [String(id)]))).toMatch(/permission denied/);
    const insert = (outcome: string, reason: string | null) =>
      client.query(
        `insert into recurring_expense_runs (location_id, recurring_id, period, outcome, skip_reason, created_by) values ($1, $2, $3, $4, $5, 'x')`,
        [String(shop.locationId), String(id), periodOf(addDays(THIS_PERIOD, 40)), outcome, reason],
      );
    expect(await err(insert("registered", null))).toMatch(/recurring_expense_runs_outcome_check/);
    expect(await err(insert("skipped", "dos\nlíneas"))).toMatch(/recurring_expense_runs_outcome_check/);
  });
});

describe("pendientes", () => {
  it("lista lo vencido o por vencer por modo, sin las pausadas", async () => {
    const s = await setupShop(db, "Pendientes");
    const cash = await template(s, { payMode: "cash", name: "Aseo" });
    const bank = await template(s, { payMode: "bank", name: "Arriendo" });
    await template(s, { payMode: "cash", name: "Futuro", startMonth: periodOf(addDays(TODAY, 70)) });
    const all = await dueRecurringExpenses(db, { locationId: s.locationId, now: NOW });
    expect(all.items.map((x) => x.template.id).sort()).toEqual([cash, bank].sort());
    const onlyCash = await dueRecurringExpenses(db, { locationId: s.locationId, payMode: "cash", now: NOW });
    expect(onlyCash.items.map((x) => x.template.id)).toEqual([cash]);
    expect(onlyCash.items[0]!.due[0]).toMatchObject({ period: THIS_PERIOD });
    await client.query(`update recurring_expenses set active = false where id = $1`, [String(cash)]);
    expect((await dueRecurringExpenses(db, { locationId: s.locationId, payMode: "cash", now: NOW })).items).toEqual([]);
    expect((await listRecurringExpenses(db, { locationId: s.locationId })).map((r) => r.name)).toEqual(["Arriendo", "Aseo", "Futuro"]);
  });

  it("lee solo los registros que importan sin cambiar el resultado: el último sigue siendo el último", async () => {
    const s = await setupShop(db, "Historial");
    const prev = periodOf(addDays(THIS_PERIOD, -1));
    const next = periodOf(addDays(THIS_PERIOD, 40));
    const luz = await template(s, { name: "Luz", startMonth: prev });
    const agua = await template(s, { name: "Agua" });
    await skip(s, luz, { period: prev });
    await skip(s, luz);
    const byId = async () => new Map((await listRecurringExpenses(db, { locationId: s.locationId })).map((r) => [r.id, r]));
    let rows = await byId();
    expect(rows.get(luz)!.done).toEqual([THIS_PERIOD, prev]);
    expect(rows.get(luz)!.lastRun).toMatchObject({ period: THIS_PERIOD, outcome: "skipped", amount: null });
    // Los registros de una plantilla no se cuelan en otra.
    expect(rows.get(agua)!).toMatchObject({ done: [], lastRun: null });
    // El mes de inicio se mueve después de los dos registros: no cuentan para duePeriods, pero el último se sigue mostrando.
    await saveRecurringExpense(db, {
      locationId: s.locationId,
      id: luz,
      categoryId: s.category,
      draft: { name: "Luz", estimatedAmount: fromUnits(800_000n), payMode: "bank", dayOfMonth: DUE_DAY, intervalMonths: 1, startMonth: next, active: true },
      actor: { userId: s.owner.userId },
      now: NOW,
    });
    rows = await byId();
    expect(rows.get(luz)!.lastRun).toMatchObject({ period: THIS_PERIOD, outcome: "skipped" });
    expect(rows.get(luz)!.done).toEqual([THIS_PERIOD]);
    expect((await dueRecurringExpenses(db, { locationId: s.locationId, now: NOW })).items.map((x) => x.template.id)).toEqual([agua]);
  });
});

describe("categoría desactivada", () => {
  it("una plantilla activa no queda con su categoría desactivada; pausarla sí se puede", async () => {
    const s = await setupShop(db, "Categoría desactivada");
    const id = await template(s, { name: "Agua" });
    const draft = { name: "Agua", estimatedAmount: fromUnits(800_000n), payMode: "bank" as const, dayOfMonth: DUE_DAY, intervalMonths: 1, startMonth: THIS_PERIOD };
    const save = (active: boolean, existing: bigint | null = id) =>
      saveRecurringExpense(db, { locationId: s.locationId, id: existing ?? undefined, categoryId: s.category, draft: { ...draft, active }, actor: { userId: s.owner.userId }, now: NOW });
    const cat = (await listExpenseCategories(db, { locationId: s.locationId })).find((c) => c.id === s.category)!;
    await saveExpenseCategory(db, { locationId: s.locationId, id: s.category, name: cat.name, accountCode: cat.accountCode, active: false });

    // La pantalla lo sabe (bloquea "Registrar") y el servidor también lo rechaza, sin dejar nada.
    const [row] = await listRecurringExpenses(db, { locationId: s.locationId });
    expect(row).toMatchObject({ id, categoryActive: false });
    const [expensesBefore, runsBefore] = [await expenseCount(s), await runCount(s)];
    expect(await err(register(s, id))).toMatch(/desactivada/);
    expect([await expenseCount(s), await runCount(s)]).toEqual([expensesBefore, runsBefore]);

    // Activa con la categoría desactivada: no. Pausada: sí. Una plantilla nueva no la elige ni pausada.
    expect(await err(save(true))).toBe("La categoría está desactivada: elige otra o pausa el gasto fijo");
    expect(await save(false)).toEqual({ id });
    expect((await listRecurringExpenses(db, { locationId: s.locationId }))[0]).toMatchObject({ id, active: false });
    expect(await err(save(false, null))).toBe("La categoría está desactivada");
  });
});

// ─── Coherencia (§6): gastos por categoría = cuentas de gasto del libro ──────

const CATEGORY_ACCOUNTS = CHART_OF_ACCOUNTS.filter((a) => isExpenseCategoryAccount(a.code)).map((a) => a.code);

async function ledgerExpenseNet(s: Shop, from: string, to: string): Promise<bigint> {
  const row = await one<{ net: string }>(
    `select coalesce(sum(l.debit - l.credit), 0)::text as net
       from journal_lines l
       join journal_entries e on e.location_id = l.location_id and e.id = l.entry_id
       join accounts a on a.location_id = l.location_id and a.id = l.account_id
      where l.location_id = $1 and a.code = any($2::text[]) and e.business_date between $3::date and $4::date`,
    [String(s.locationId), CATEGORY_ACCOUNTS, from, to],
  );
  return BigInt(row.net);
}

describe("coherencia del informe de gastos", () => {
  it("la suma de Gastos por categoría es el neto de las cuentas de gasto del libro, con gastos fijos incluidos", { timeout: 300_000 }, async () => {
    const op = fc.record({
      kind: fc.constantFrom("bank", "cash", "recurringBank", "recurringCash"),
      units: fc.bigInt({ min: 1n, max: 400_000n }),
      daysAgo: fc.integer({ min: 0, max: 5 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 6 }), fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), async (ops, a, b) => {
        const s = await setupShop(db, `Coherencia ${key()}`);
        await openCashSession(db, { locationId: s.locationId, counted: fromUnits(5_000_000n), note: "Base inicial de prueba", idempotencyKey: key("open"), actor: s.owner, now: NOW });
        for (const o of ops) {
          const amount = fromUnits(o.units);
          if (o.kind === "bank" || o.kind === "cash") {
            // Los de banco, en días distintos; los de caja, hoy (la caja abierta es de hoy).
            const now = o.kind === "bank" ? new Date(NOW.getTime() - o.daysAgo * 86_400_000) : NOW;
            await addExpense(db, { locationId: s.locationId, categoryId: s.category, amount, paidFrom: o.kind, description: "Gasto suelto", idempotencyKey: key(), actor: s.owner, now });
          } else {
            const payMode = o.kind === "recurringBank" ? "bank" : "cash";
            const id = await template(s, { payMode });
            await register(s, id, { payMode, units: o.units });
          }
        }
        const from = addDays(TODAY, -Math.max(a, b));
        const to = addDays(TODAY, -Math.min(a, b));
        for (const [f, t] of [
          [from, to],
          [addDays(TODAY, -10), TODAY],
        ] as const) {
          const rows = await expensesByCategory(db, { locationId: s.locationId, from: f, to: t });
          const report = rows.reduce((acc, r) => acc + r.amount, 0n);
          expect(report).toBe(await ledgerExpenseNet(s, f, t));
        }
      }),
      { numRuns: 6 },
    );
  });
});
