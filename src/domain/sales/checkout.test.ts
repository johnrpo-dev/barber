import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ACCOUNTS, CHART_OF_ACCOUNTS } from "../ledger/accounts";
import { assertValidEntry, netByAccount, reversalOf } from "../ledger/entry";
import { allocate, fromUnits, type Money, money, PESO, percentOf } from "../money";
import { cashAdjustmentEntry, cashDepositEntry, countCash, expenseEntry, isExpenseCategoryAccount, tipPayoutEntry } from "./cash";
import {
  type CheckoutInput,
  CheckoutError,
  type CheckoutRules,
  DEFAULT_CHECKOUT_RULES,
  type PaymentKind,
  priceCheckout,
  saleEntry,
} from "./checkout";

const META = { businessDate: "2026-11-02", memo: "Venta de prueba" };
const cop = (pesos: number) => fromUnits(BigInt(pesos));

describe("el ejemplo del diseño (docs/sprint-4-cobro-caja.md §3)", () => {
  const checkout = priceCheckout({
    lines: [{ staffId: 1n, description: "Corte", unitPrice: cop(30_000), discount: cop(3_000), discountReason: "Cliente frecuente", commissionBps: 4_000n }],
    tips: [{ staffId: 1n, amount: cop(5_000) }],
    payments: [
      { methodId: 1n, kind: "cash", amount: cop(20_000), tendered: cop(50_000), feeBps: 0n },
      { methodId: 2n, kind: "card", amount: cop(12_000), feeBps: 299n },
    ],
  });

  it("congela la comisión sobre el neto, calcula el cambio y el datáfono", () => {
    expect(checkout.netTotal).toEqual(cop(27_000));
    expect(checkout.lines[0]!.commission).toEqual(cop(10_800));
    expect(checkout.payments[0]!.change).toEqual(cop(30_000));
    expect(checkout.feesTotal).toEqual(money(35_880n));
  });

  it("arma exactamente el asiento de la tabla", () => {
    const entry = saleEntry(checkout, META);
    assertValidEntry(entry);
    const net = netByAccount(entry.lines);
    expect(net.get(ACCOUNTS.cash.code)).toEqual(cop(20_000));
    expect(net.get(ACCOUNTS.bank.code)).toEqual(money(1_164_120n));
    expect(net.get(ACCOUNTS.cardFees.code)).toEqual(money(35_880n));
    expect(net.get(ACCOUNTS.serviceIncome.code)).toEqual(cop(-27_000));
    expect(net.get(ACCOUNTS.tipsPayable.code)).toEqual(cop(-5_000));
    expect(net.get(ACCOUNTS.commissionExpense.code)).toEqual(cop(10_800));
    expect(net.get(ACCOUNTS.commissionsPayable.code)).toEqual(cop(-10_800));
  });
});

describe("validaciones del cobro", () => {
  const line = { staffId: 1n, description: "Corte", unitPrice: cop(30_000), discount: cop(0), commissionBps: 4_000n };
  const cash = (pesos: number, tendered?: number) => ({
    methodId: 1n,
    kind: "cash" as const,
    amount: cop(pesos),
    tendered: tendered === undefined ? undefined : cop(tendered),
    feeBps: 0n,
  });
  const fails = (input: CheckoutInput, message: RegExp, rules?: CheckoutRules) =>
    expect(() => priceCheckout(input, rules)).toThrow(message);

  it("rechaza lo que no cuadra o no tiene sentido", () => {
    fails({ lines: [], tips: [], payments: [] }, /no tiene servicios/);
    fails({ lines: [line], tips: [], payments: [cash(20_000)] }, /Falta dinero/);
    fails({ lines: [line], tips: [], payments: [cash(40_000)] }, /superan el total/);
    fails({ lines: [line], tips: [], payments: [cash(30_000, 20_000)] }, /no alcanza/);
    fails({ lines: [{ ...line, discount: cop(3_000) }], tips: [], payments: [cash(27_000)] }, /motivo/);
    fails({ lines: [{ ...line, discount: cop(10_000), discountReason: "x" }], tips: [], payments: [cash(20_000)] }, /tope/);
    fails({ lines: [{ ...line, discount: cop(30_000), discountReason: "x" }], tips: [], payments: [] }, /tope/);
    fails(
      { lines: [{ ...line, discount: cop(30_000), discountReason: "cortesía" }], tips: [], payments: [] },
      /nada que cobrar/,
      { ...DEFAULT_CHECKOUT_RULES, maxDiscountBps: 10_000n },
    );
    fails({ lines: [line], tips: [{ staffId: 1n, amount: cop(0) }], payments: [cash(30_000)] }, /mayor que cero/);
    fails({ lines: [line], tips: [], payments: [cash(15_000), cash(15_000)] }, /mismo medio/);
    fails({ lines: [line], tips: [], payments: [{ ...cash(30_000), feeBps: 100n }] }, /efectivo no tiene costo/);
    fails({ lines: [line], tips: [], payments: [{ methodId: 2n, kind: "card", amount: cop(30_000), tendered: cop(50_000), feeBps: 0n }] }, /Solo el efectivo/);
    fails({ lines: [{ ...line, commissionBps: 10_001n }], tips: [], payments: [cash(30_000)] }, /entre 0 % y 100 %/);
  });

  it("el tope del descuento es exacto: el tope pasa, un peso más no", () => {
    const at = (discount: number) => ({ lines: [{ ...line, discount: cop(discount), discountReason: "x" }], tips: [], payments: [cash(30_000 - discount)] });
    expect(priceCheckout(at(9_000)).discount).toEqual(cop(9_000));
    fails(at(9_001), /tope permitido \(30 %\)/);
    fails({ lines: [{ ...line, unitPrice: cop(20_000), discount: cop(5_101), discountReason: "x" }], tips: [], payments: [cash(14_899)] }, /25,5 %/, {
      ...DEFAULT_CHECKOUT_RULES,
      maxDiscountBps: 2_550n,
    });
  });

  it("pesos enteros donde el dinero es físico, topes de tamaño y costo del datáfono menor que el pago", () => {
    fails({ lines: [{ ...line, unitPrice: money(3_000_050n) }], tips: [], payments: [{ methodId: 2n, kind: "card", amount: money(3_000_050n), feeBps: 0n }] }, /pesos enteros/);
    fails({ lines: [line], tips: [], payments: [{ ...cash(30_000), amount: money(3_000_050n), tendered: undefined }] }, /pesos enteros/);
    fails({ lines: [{ ...line, unitPrice: money(10n ** 14n) }], tips: [], payments: [cash(30_000)] }, /demasiado grande/);
    fails({ lines: [line], tips: [], payments: [{ methodId: 2n, kind: "card", amount: cop(30_000), feeBps: 10_000n }] }, /entre 0 % y 99,99 %/);
    fails({ lines: [{ ...line, description: "  " }], tips: [], payments: [cash(30_000)] }, /descripción/);
    fails({ lines: Array.from({ length: 21 }, () => line), tips: [], payments: [cash(630_000)] }, /demasiadas/);
    // Una propina de un peso con datáfono casi total: se rechaza en vez de dejar al barbero en cero.
    fails(
      { lines: [{ ...line, unitPrice: cop(0) }], tips: [{ staffId: 1n, amount: cop(1) }], payments: [{ methodId: 2n, kind: "card", amount: cop(1), feeBps: 9_999n }] },
      /costo del medio de pago/,
      { ...DEFAULT_CHECKOUT_RULES, tipsBearCardFees: true },
    );
  });

  it("los errores son CheckoutError (mensajes para el usuario)", () => {
    expect(() => priceCheckout({ lines: [], tips: [], payments: [] })).toThrow(CheckoutError);
  });
});

// ─── Propiedades ─────────────────────────────────────────────────────────────

const KINDS: PaymentKind[] = ["cash", "card", "transfer", "wallet"];
const bps = fc.bigInt({ min: 0n, max: 10_000n });

/** Venta arbitraria válida: el total se reparte entre los medios de pago con allocate(). */
const sale = fc
  .record({
    lines: fc.array(
      fc.record({
        staffId: fc.bigInt({ min: 1n, max: 4n }),
        pricePesos: fc.bigInt({ min: 0n, max: 500_000n }),
        discountBps: fc.bigInt({ min: 0n, max: 3_000n }),
        commissionBps: bps,
      }),
      { minLength: 1, maxLength: 4 },
    ),
    tips: fc.uniqueArray(fc.record({ staffId: fc.bigInt({ min: 1n, max: 4n }), amount: fc.bigInt({ min: 1n, max: 100_000n }).map((p) => p * PESO) }), {
      selector: (t) => t.staffId,
      maxLength: 3,
    }),
    payments: fc.uniqueArray(fc.record({ kind: fc.constantFrom(...KINDS), weight: fc.bigInt({ min: 1n, max: 100n }), feeBps: fc.oneof(fc.bigInt({ min: 0n, max: 500n }), fc.bigInt({ min: 0n, max: 9_999n })), extraCash: fc.bigInt({ min: 0n, max: 100_000n }).map((p) => p * PESO) }), {
      selector: (p) => p.kind,
      minLength: 1,
      maxLength: 4,
    }),
    rules: fc.record({ commissionBase: fc.constantFrom("net" as const, "gross" as const), maxDiscountBps: fc.constant(3_000n), tipsBearCardFees: fc.boolean() }),
  })
  .map(({ lines, tips, payments, rules }) => {
    const priced = lines.map((l) => {
      const unitPrice = fromUnits(l.pricePesos);
      // Descuento en pesos enteros, por debajo del tope (truncado, no redondeado).
      const discount = fromUnits((l.pricePesos * l.discountBps) / 10_000n);
      return { staffId: l.staffId, description: "Servicio", unitPrice, discount, discountReason: "motivo", commissionBps: l.commissionBps };
    });
    const due = priced.reduce((a, l) => a + l.unitPrice.minor - l.discount.minor, 0n) + tips.reduce((a, t) => a + t.amount, 0n);
    // Se reparte en pesos enteros: así el efectivo nunca lleva centavos.
    const amounts = due > 0n ? allocate(money(due / PESO), payments.map((p) => p.weight)).map((m) => money(m.minor * PESO)) : [];
    const input: CheckoutInput = {
      lines: priced,
      tips: tips.map((t) => ({ staffId: t.staffId, amount: money(t.amount) })),
      payments: payments
        .map((p, i) => ({
          methodId: BigInt(i + 1),
          kind: p.kind,
          amount: amounts[i] ?? money(0n),
          tendered: p.kind === "cash" ? money((amounts[i]?.minor ?? 0n) + p.extraCash) : undefined,
          feeBps: p.kind === "cash" ? 0n : p.feeBps,
        }))
        .filter((p) => p.amount.minor > 0n),
    };
    return { input, rules: rules as CheckoutRules, due };
  })
  .filter(({ due }) => due > 0n);

const total = (ms: readonly Money[]) => ms.reduce((a, m) => a + m.minor, 0n);

/** Con costos de datáfono cercanos al 100 % el cobro puede rechazarse, pero solo con CheckoutError. */
function priceOrReject(input: CheckoutInput, rules: CheckoutRules) {
  try {
    return priceCheckout(input, rules);
  } catch (err) {
    expect(err).toBeInstanceOf(CheckoutError);
    expect((err as Error).message).toMatch(/costo del medio de pago/);
    return null;
  }
}

describe("propiedades del cobro", () => {
  it("todo asiento de venta cuadra y pagado = neto + propinas", () => {
    fc.assert(
      fc.property(sale, ({ input, rules }) => {
        const c = priceOrReject(input, rules);
        if (!c) return;
        expect(total(c.payments.map((p) => p.amount))).toBe(c.netTotal.minor + c.tipsTotal.minor);
        const entry = saleEntry(c, META);
        expect(() => assertValidEntry(entry)).not.toThrow();
      }),
      { numRuns: 1_000 },
    );
  });

  it("cada monto cae en su cuenta: caja, banco, datáfono, ingreso, propinas y comisión", () => {
    fc.assert(
      fc.property(sale, ({ input, rules }) => {
        const c = priceOrReject(input, rules);
        if (!c) return;
        const net = netByAccount(saleEntry(c, META).lines);
        const at = (code: string) => net.get(code as never)?.minor ?? 0n;
        const cash = total(c.payments.filter((p) => p.kind === "cash").map((p) => p.amount));
        const electronic = total(c.payments.filter((p) => p.kind !== "cash").map((p) => p.amount));
        expect(at(ACCOUNTS.cash.code)).toBe(cash);
        expect(at(ACCOUNTS.bank.code)).toBe(electronic - c.feesTotal.minor);
        expect(at(ACCOUNTS.cardFees.code)).toBe(c.businessFees.minor);
        expect(at(ACCOUNTS.serviceIncome.code)).toBe(-c.netTotal.minor);
        expect(at(ACCOUNTS.tipsPayable.code)).toBe(-total(c.tips.map((t) => t.payable)));
        expect(at(ACCOUNTS.commissionExpense.code)).toBe(c.commissionTotal.minor);
        expect(at(ACCOUNTS.commissionsPayable.code)).toBe(-c.commissionTotal.minor);
        for (const t of c.tips) expect(t.payable.minor).toBeGreaterThan(0n);
      }),
      { numRuns: 1_000 },
    );
  });

  it("la comisión de cada línea es percentOf(base, bps, PESO) y el total es su suma, sin re-redondear", () => {
    fc.assert(
      fc.property(sale, ({ input, rules }) => {
        const c = priceOrReject(input, rules);
        if (!c) return;
        for (const l of c.lines) {
          const base = rules.commissionBase === "net" ? l.net : l.unitPrice;
          expect(l.commission).toEqual(percentOf(base, l.commissionBps, PESO));
          expect(l.commission.minor % PESO).toBe(0n);
        }
        expect(c.commissionTotal.minor).toBe(total(c.lines.map((l) => l.commission)));
      }),
    );
  });

  it("el cambio es entregado − aplicado y nunca es negativo", () => {
    fc.assert(
      fc.property(sale, ({ input, rules }) => {
        for (const p of priceOrReject(input, rules)?.payments ?? []) {
          expect(p.change.minor).toBeGreaterThanOrEqual(0n);
          if (p.kind === "cash") expect(p.change.minor).toBe(p.tendered!.minor - p.amount.minor);
          else expect(p.change.minor).toBe(0n);
        }
      }),
    );
  });

  it("el datáfono se reparte sin perder centavos y ninguna propina queda negativa", () => {
    fc.assert(
      fc.property(sale, ({ input, rules }) => {
        const c = priceOrReject(input, rules);
        if (!c) return;
        expect(c.businessFees.minor + c.tipFees.minor).toBe(c.feesTotal.minor);
        if (!rules.tipsBearCardFees) expect(c.tipFees.minor).toBe(0n);
        expect(total(c.tips.map((t) => t.amount)) - total(c.tips.map((t) => t.payable))).toBe(c.tipFees.minor);
        for (const t of c.tips) expect(t.payable.minor).toBeGreaterThanOrEqual(0n);
      }),
    );
  });

  it("anular una venta deja todas las cuentas como estaban", () => {
    fc.assert(
      fc.property(sale, ({ input, rules }) => {
        const c = priceOrReject(input, rules);
        if (!c) return;
        const entry = saleEntry(c, META);
        const reversal = reversalOf(entry, META.businessDate, "anulada");
        assertValidEntry(reversal);
        for (const [, balance] of netByAccount([...entry.lines, ...reversal.lines])) expect(balance.minor).toBe(0n);
      }),
    );
  });
});

describe("asientos de caja y gastos", () => {
  const amount = fc.bigInt({ min: 1n, max: 10n ** 10n }).map((m) => money(m));

  it("gasto, pago de propinas y consignación cuadran y mueven la caja en el sentido correcto", () => {
    fc.assert(
      fc.property(amount, fc.constantFrom("cash" as const, "bank" as const), (m, paidFrom) => {
        for (const entry of [
          expenseEntry({ amount: m, expenseAccount: ACCOUNTS.generalExpense.code, paidFrom }, META),
          tipPayoutEntry(m, META),
          cashDepositEntry(m, META),
        ]) {
          assertValidEntry(entry);
        }
        expect(netByAccount(tipPayoutEntry(m, META).lines).get(ACCOUNTS.cash.code)?.minor).toBe(-m.minor);
        expect(netByAccount(cashDepositEntry(m, META).lines).get(ACCOUNTS.bank.code)?.minor).toBe(m.minor);
      }),
    );
  });

  it("el ajuste de caja lleva la caja exactamente a lo contado", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 10n }), fc.bigInt({ min: 0n, max: 10n ** 10n }), (expected, counted) => {
        const entry = cashAdjustmentEntry({ expected: money(expected), counted: money(counted) }, "conteo", META);
        if (expected === counted) {
          expect(entry).toBeNull();
          return;
        }
        assertValidEntry(entry!);
        expect(expected + (netByAccount(entry!.lines).get(ACCOUNTS.cash.code)?.minor ?? 0n)).toBe(counted);
      }),
    );
  });

  it("un gasto solo se carga a cuentas de gasto sin flujo propio", () => {
    expect(isExpenseCategoryAccount(ACCOUNTS.generalExpense.code)).toBe(true);
    for (const code of CHART_OF_ACCOUNTS.map((a) => a.code).filter((c) => c !== ACCOUNTS.generalExpense.code)) {
      expect(isExpenseCategoryAccount(code), code).toBe(false);
      expect(() => expenseEntry({ amount: cop(1_000), expenseAccount: code, paidFrom: "cash" }, META)).toThrow(/no es de gasto/);
    }
    expect(() => expenseEntry({ amount: cop(1_000), expenseAccount: "9999", paidFrom: "bank" }, META)).toThrow(/no es de gasto/);
  });

  it("una diferencia sin nota no se registra; montos no positivos tampoco", () => {
    expect(() => cashAdjustmentEntry({ expected: cop(100_000), counted: cop(99_000) }, "  ", META)).toThrow(/faltante/);
    expect(() => cashAdjustmentEntry({ expected: cop(100_000), counted: cop(101_000) }, undefined, META)).toThrow(/sobrante/);
    expect(() => tipPayoutEntry(cop(0), META)).toThrow(/mayor que cero/);
    expect(() => countCash(cop(0), money(-1n))).toThrow(/negativo/);
  });
});
