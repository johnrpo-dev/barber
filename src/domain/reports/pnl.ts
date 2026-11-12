import { ACCOUNTS, type AccountType } from "../ledger/accounts";
import { type Money, money, subtract } from "../money";
import { ReportError } from "./period";

// Estado de resultados (docs/sprint-5-comisiones-informes.md §6.2). Las sumas salen de SQL
// (GROUPING SETS); aquí solo se da forma y se verifica que filas y totales digan lo mismo.

export interface AccountTotalRow {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly debits: bigint;
  readonly credits: bigint;
}

/** De SQL: ingresos = Σ(crédito − débito), gastos = Σ(débito − crédito), utilidad = la diferencia. */
export interface PnlTotals {
  readonly income: bigint;
  readonly expenses: bigint;
  readonly profit: bigint;
}

export interface PnlLine {
  readonly code: string;
  readonly name: string;
  readonly amount: Money;
}

export interface Pnl {
  readonly income: readonly PnlLine[];
  readonly expenses: readonly PnlLine[];
  readonly totalIncome: Money;
  readonly totalExpenses: Money;
  readonly profit: Money;
}

/** Da forma y verifica (Σ filas = totales de SQL; utilidad = ingresos − gastos). Lanza ReportError si no. */
export function assemblePnl(rows: readonly AccountTotalRow[], totals: PnlTotals): Pnl {
  const income: PnlLine[] = [];
  const expenses: PnlLine[] = [];
  let checkIncome = 0n;
  let checkExpenses = 0n;
  for (const r of [...rows].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))) {
    if (r.type === "income") {
      const amount = r.credits - r.debits;
      checkIncome += amount;
      income.push({ code: r.code, name: r.name, amount: money(amount) });
    } else if (r.type === "expense") {
      const amount = r.debits - r.credits;
      checkExpenses += amount;
      expenses.push({ code: r.code, name: r.name, amount: money(amount) });
    } else {
      throw new ReportError(`El estado de resultados recibió una cuenta que no es de ingreso ni de gasto (${r.code})`);
    }
  }
  if (checkIncome !== totals.income || checkExpenses !== totals.expenses || totals.profit !== totals.income - totals.expenses) {
    throw new ReportError("El estado de resultados no cuadra con sus totales; no se muestra");
  }
  return { income, expenses, totalIncome: money(totals.income), totalExpenses: money(totals.expenses), profit: money(totals.profit) };
}

/** Ventas de productos contra su costo en el periodo (sprint 6, fase D). */
export interface ProductMargin {
  /** 4135: ventas netas de productos. */
  readonly income: Money;
  /** 6135: costo de ventas (lo fija el conteo de inventario). */
  readonly cost: Money;
  /** income − cost. */
  readonly margin: Money;
}

/**
 * Margen de productos a partir del estado de resultados ya armado (cuyas sumas vienen de SQL): 4135 −
 * 6135. Null si el periodo no tiene ni ventas de productos ni costo. El costo solo existe donde hubo un
 * conteo: un periodo sin conteo muestra las ventas con costo 0, y la pantalla lo advierte.
 */
export function productMargin(pnl: Pnl): ProductMargin | null {
  const income = pnl.income.find((l) => l.code === ACCOUNTS.productIncome.code)?.amount ?? money(0n);
  const cost = pnl.expenses.find((l) => l.code === ACCOUNTS.costOfGoodsSold.code)?.amount ?? money(0n);
  if (income.minor === 0n && cost.minor === 0n) return null;
  return { income, cost, margin: subtract(income, cost) };
}
