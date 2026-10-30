import { and, asc, eq, sql } from "drizzle-orm";
import { type CheckoutRules, CheckoutError, type PaymentKind } from "@/domain/sales/checkout";
import { CashError, isExpenseCategoryAccount } from "@/domain/sales/cash";
import type { Money } from "@/domain/money";
import { expenseCategories, locations, paymentMethods } from "./schema";
import { pgError } from "./serializable";
import type { Db } from "./types";

// Ajustes del cobro (docs/sprint-4-cobro-caja.md §1 y §9): medios de pago con su costo,
// categorías de gasto y reglas de la sede. El cobro los lee SIEMPRE de aquí, nunca del navegador.

export interface LocationCheckoutRules extends CheckoutRules {
  receptionCanDiscount: boolean;
  timeZone: string;
  /** Conteo a ciegas: un cierre con |diferencia| mayor que esto queda para revisión del dueño (centavos). */
  cashReviewThreshold: bigint;
}

export async function checkoutRulesOf(db: Db, locationId: bigint): Promise<LocationCheckoutRules> {
  const [row] = await db
    .select({
      timeZone: locations.timezone,
      commissionBase: locations.commissionBase,
      maxDiscountBps: locations.maxDiscountBps,
      receptionCanDiscount: locations.receptionCanDiscount,
      tipsBearCardFees: locations.tipsBearCardFees,
      cashReviewThreshold: locations.cashReviewThreshold,
    })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!row) throw new Error(`La sede ${locationId} no existe`);
  return { ...row, maxDiscountBps: BigInt(row.maxDiscountBps) };
}

export async function updateCheckoutRules(
  db: Db,
  locationId: bigint,
  rules: {
    commissionBase: "net" | "gross";
    maxDiscountBps: bigint;
    receptionCanDiscount: boolean;
    tipsBearCardFees: boolean;
    /** Sin valor, el límite de revisión de cierres queda como está. */
    cashReviewThreshold?: Money;
  },
): Promise<void> {
  if (rules.maxDiscountBps < 0n || rules.maxDiscountBps > 10_000n) throw new CheckoutError("El tope de descuento debe estar entre 0 % y 100 %");
  const threshold = rules.cashReviewThreshold?.minor;
  if (threshold !== undefined) {
    // La base también lo exige (locations_cash_review_threshold_check).
    if (threshold < 0n || threshold % 100n !== 0n || threshold > 10n ** 13n) {
      throw new CashError("El límite de diferencia de caja debe ser un valor en pesos enteros, de cero en adelante");
    }
  }
  await db
    .update(locations)
    .set({
      commissionBase: rules.commissionBase,
      maxDiscountBps: Number(rules.maxDiscountBps),
      receptionCanDiscount: rules.receptionCanDiscount,
      tipsBearCardFees: rules.tipsBearCardFees,
      ...(threshold === undefined ? {} : { cashReviewThreshold: threshold }),
    })
    .where(eq(locations.id, locationId));
}

// ─── Medios de pago ──────────────────────────────────────────────────────────

export interface PaymentMethodRow {
  id: bigint;
  kind: PaymentKind;
  label: string;
  feeBps: bigint;
  active: boolean;
}

export async function listPaymentMethods(db: Db, input: { locationId: bigint; activeOnly?: boolean }): Promise<PaymentMethodRow[]> {
  const rows = await db
    .select({ id: paymentMethods.id, kind: paymentMethods.kind, label: paymentMethods.label, feeBps: paymentMethods.feeBps, active: paymentMethods.active })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.locationId, input.locationId), input.activeOnly ? eq(paymentMethods.active, true) : undefined))
    // El efectivo primero; después en el orden en que se crearon.
    .orderBy(sql`${paymentMethods.kind} <> 'cash'`, asc(paymentMethods.id));
  return rows.map((r) => ({ ...r, feeBps: BigInt(r.feeBps) }));
}

const MAX_FEE_BPS = 9_999n;

export async function savePaymentMethod(
  db: Db,
  input: { locationId: bigint; id?: bigint; kind: PaymentKind; label: string; feeBps: bigint; active: boolean },
): Promise<bigint> {
  const label = input.label.trim();
  if (!label || label.length > 40) throw new CheckoutError("Escribe un nombre de hasta 40 caracteres para el medio de pago");
  if (input.feeBps < 0n || input.feeBps > MAX_FEE_BPS) throw new CheckoutError("El costo del medio de pago debe estar entre 0 % y 99,99 %");
  if (input.kind === "cash" && input.feeBps !== 0n) throw new CheckoutError("El efectivo no tiene costo de datáfono");
  if (input.kind === "cash" && !input.active) throw new CheckoutError("El efectivo no se puede desactivar");
  try {
    if (input.id === undefined) {
      if (input.kind === "cash") throw new CheckoutError("La sede ya tiene efectivo");
      const [row] = await db
        .insert(paymentMethods)
        .values({ locationId: input.locationId, kind: input.kind, label, feeBps: Number(input.feeBps), active: input.active })
        .returning({ id: paymentMethods.id });
      return row!.id;
    }
    const [current] = await db
      .select({ kind: paymentMethods.kind })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.locationId, input.locationId), eq(paymentMethods.id, input.id)));
    if (!current) throw new CheckoutError("El medio de pago no existe");
    if (current.kind !== input.kind) throw new CheckoutError("El tipo de un medio de pago no se cambia; crea uno nuevo");
    await db
      .update(paymentMethods)
      .set({ label, feeBps: Number(input.feeBps), active: input.active, updatedAt: sql`now()` })
      .where(and(eq(paymentMethods.locationId, input.locationId), eq(paymentMethods.id, input.id)));
    return input.id;
  } catch (err) {
    if (pgError(err).constraint === "payment_methods_location_label_key") throw new CheckoutError("Ya hay un medio de pago con ese nombre");
    throw err;
  }
}

// ─── Categorías de gasto ─────────────────────────────────────────────────────

export interface ExpenseCategoryRow {
  id: bigint;
  name: string;
  accountCode: string;
  active: boolean;
}

export async function listExpenseCategories(db: Db, input: { locationId: bigint; activeOnly?: boolean }): Promise<ExpenseCategoryRow[]> {
  return db
    .select({ id: expenseCategories.id, name: expenseCategories.name, accountCode: expenseCategories.accountCode, active: expenseCategories.active })
    .from(expenseCategories)
    .where(and(eq(expenseCategories.locationId, input.locationId), input.activeOnly ? eq(expenseCategories.active, true) : undefined))
    .orderBy(asc(expenseCategories.name));
}

export async function saveExpenseCategory(
  db: Db,
  input: { locationId: bigint; id?: bigint; name: string; accountCode: string; active: boolean },
): Promise<bigint> {
  const name = input.name.trim();
  if (!name || name.length > 60) throw new CheckoutError("Escribe un nombre de hasta 60 caracteres para la categoría");
  if (!isExpenseCategoryAccount(input.accountCode)) {
    throw new CheckoutError("Esa cuenta no sirve para una categoría de gasto: elige una cuenta de gasto sin flujo propio");
  }
  try {
    if (input.id === undefined) {
      const [row] = await db
        .insert(expenseCategories)
        .values({ locationId: input.locationId, name, accountCode: input.accountCode, active: input.active })
        .returning({ id: expenseCategories.id });
      return row!.id;
    }
    const updated = await db
      .update(expenseCategories)
      .set({ name, accountCode: input.accountCode, active: input.active, updatedAt: sql`now()` })
      .where(and(eq(expenseCategories.locationId, input.locationId), eq(expenseCategories.id, input.id)))
      .returning({ id: expenseCategories.id });
    if (updated.length === 0) throw new CheckoutError("La categoría no existe");
    return input.id;
  } catch (err) {
    if (pgError(err).constraint === "expense_categories_location_name_key") throw new CheckoutError("Ya hay una categoría con ese nombre");
    throw err;
  }
}
