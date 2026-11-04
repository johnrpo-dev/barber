import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ACCOUNTS } from "../ledger/accounts";
import { assertValidEntry, netByAccount } from "../ledger/entry";
import { fromUnits, type Money, money } from "../money";
import {
  type AdjustmentInput,
  assertCutoff,
  assertReversible,
  computeSettlement,
  type PendingCommission,
  receiptNumberLabel,
  requireSettlementReason,
  SettlementError,
  type SettlementInput,
  settlementEntry,
  settledTips,
  staffAdvanceEntry,
} from "./settlement";

// docs/sprint-5-comisiones-informes.md §3, §4 y §11.

const cop = (pesos: bigint) => fromUnits(pesos);
const line = (id: bigint, pesos: bigint, day = "2026-11-10"): PendingCommission => ({ saleLineId: id, businessDate: day, commission: cop(pesos) });
const meta = { businessDate: "2026-11-15", memo: "Liquidación", idempotencyKey: "settlement:k1" };

const base: SettlementInput = {
  commissions: [],
  clawbacks: [],
  tipsOwed: money(0n),
  includeTips: true,
  receivable: money(0n),
  advanceDeduction: "max",
  adjustments: [],
};

function nets(entry: ReturnType<typeof settlementEntry>) {
  return Object.fromEntries([...netByAccount(entry.lines)].map(([k, v]) => [k, v.minor]));
}

describe("liquidación: ejemplos del documento", () => {
  it("Ejemplo 1 (Andrés): paga $24.800 de la caja y el asiento suma $56.800 por lado", () => {
    const draft = computeSettlement({
      ...base,
      commissions: [line(1n, 10_800n), line(2n, 8_000n), line(3n, 18_000n)],
      clawbacks: [{ saleLineId: 9n, businessDate: "2026-10-28", commission: cop(12_000n) }],
      tipsOwed: cop(15_000n),
      receivable: cop(20_000n),
      adjustments: [{ direction: "add", amount: cop(5_000n), reason: "Bono por cubrir el domingo" }],
    });
    expect(draft.commissionTotal).toEqual(cop(36_800n));
    expect(draft.clawbackTotal).toEqual(cop(12_000n));
    expect(draft.gross).toEqual(cop(44_800n));
    expect(draft.advanceDeduction).toEqual(cop(20_000n));
    expect(draft.carryOver).toEqual(cop(0n));
    expect(draft.payout).toEqual(cop(24_800n));
    expect(draft.lines.map((l) => [l.kind, l.amount.minor / 100n])).toEqual([
      ["commission", 10_800n],
      ["commission", 8_000n],
      ["commission", 18_000n],
      ["clawback", -12_000n],
      ["tips", 15_000n],
      ["adjustment", 5_000n],
      ["advance_deduction", -20_000n],
    ]);
    const entry = settlementEntry(draft, { ...meta, paidFrom: "cash" });
    assertValidEntry(entry);
    const debits = entry.lines.filter((l) => l.side === "debit").reduce((a, l) => a + l.amount.minor, 0n);
    expect(debits).toBe(cop(56_800n).minor);
    expect(entry.kind).toBe("commission_payout");
    // Las dos líneas de 2335 van separadas (comisión y anulación), como en la tabla del documento.
    expect(entry.lines.filter((l) => l.account === ACCOUNTS.commissionsPayable.code)).toHaveLength(2);
    expect(nets(entry)).toEqual({
      "2335": cop(24_800n).minor,
      "2380": cop(15_000n).minor,
      "5105": cop(5_000n).minor,
      "1365": -cop(20_000n).minor,
      "1105": -cop(24_800n).minor,
    });
  });

  it("Ejemplo 2 (Camilo): arrastre de $12.000, pago $0 sin mover dinero", () => {
    const draft = computeSettlement({
      ...base,
      commissions: [line(1n, 6_000n)],
      clawbacks: [{ saleLineId: 2n, businessDate: "2026-10-20", commission: cop(18_000n) }],
    });
    expect(draft.gross).toEqual(cop(-12_000n));
    expect(draft.carryOver).toEqual(cop(12_000n));
    expect(draft.payout).toEqual(cop(0n));
    expect(draft.advanceDeduction).toEqual(cop(0n));
    const entry = settlementEntry(draft, { ...meta, paidFrom: null });
    assertValidEntry(entry);
    expect(nets(entry)).toEqual({ "2335": -cop(12_000n).minor, "1365": cop(12_000n).minor });
    expect(() => settlementEntry(draft, { ...meta, paidFrom: "cash" })).toThrow(SettlementError);
  });

  it("propinas con centavos: se liquidan $15.000 y los $0,50 quedan pendientes", () => {
    expect(settledTips(money(1_500_050n))).toEqual(cop(15_000n));
    expect(settledTips(money(-1_500_050n))).toEqual(cop(-15_000n));
    const draft = computeSettlement({ ...base, tipsOwed: money(1_500_050n) });
    expect(draft.tips).toEqual(cop(15_000n));
    expect(draft.payout).toEqual(cop(15_000n));
  });

  it("sin la casilla de propinas no se pagan; si el saldo es negativo, se recupera igual", () => {
    expect(() => computeSettlement({ ...base, tipsOwed: cop(5_000n), includeTips: false })).toThrow("No hay nada que liquidar");
    const draft = computeSettlement({ ...base, commissions: [line(1n, 10_000n)], tipsOwed: cop(-3_000n), includeTips: false });
    expect(draft.tips).toEqual(cop(-3_000n));
    expect(draft.payout).toEqual(cop(7_000n));
  });

  it("los descuentos y los bonos van en líneas separadas de 5105", () => {
    const draft = computeSettlement({
      ...base,
      commissions: [line(1n, 20_000n)],
      adjustments: [
        { direction: "add", amount: cop(3_000n), reason: "Bono" },
        { direction: "deduct", amount: cop(3_000n), reason: "Llegó tarde" },
      ],
    });
    const entry = settlementEntry(draft, { ...meta, paidFrom: "bank" });
    expect(entry.lines.filter((l) => l.account === ACCOUNTS.commissionExpense.code)).toHaveLength(2);
    expect(nets(entry)["5105"]).toBe(0n);
    expect(nets(entry)["1110"]).toBe(-cop(20_000n).minor);
  });

  it("descuento de anticipos: por defecto el máximo; uno mayor que lo posible se rechaza", () => {
    const input = { ...base, commissions: [line(1n, 10_000n)], receivable: cop(25_000n) };
    expect(computeSettlement(input).advanceDeduction).toEqual(cop(10_000n));
    expect(computeSettlement({ ...input, advanceDeduction: cop(4_000n) }).payout).toEqual(cop(6_000n));
    expect(() => computeSettlement({ ...input, advanceDeduction: cop(10_001n) })).toThrow("El descuento de anticipos supera lo que se puede descontar");
    expect(() => computeSettlement({ ...input, advanceDeduction: money(150n) })).toThrow(SettlementError);
  });

  it("ajustes: motivo obligatorio, pesos enteros y a lo sumo 10", () => {
    const adj = (a: Partial<AdjustmentInput>): SettlementInput => ({
      ...base,
      commissions: [line(1n, 10_000n)],
      adjustments: [{ direction: "add", amount: cop(1_000n), reason: "Bono", ...a }],
    });
    expect(() => computeSettlement(adj({ reason: "  " }))).toThrow("Escribe el motivo del ajuste");
    expect(() => computeSettlement(adj({ reason: "ab" }))).toThrow("Escribe el motivo del ajuste");
    expect(() => computeSettlement(adj({ reason: "x".repeat(301) }))).toThrow("es muy largo");
    expect(() => computeSettlement(adj({ amount: money(150n) }))).toThrow("pesos enteros");
    expect(() => computeSettlement(adj({ amount: cop(0n) }))).toThrow(SettlementError);
    const many = Array.from({ length: 11 }, () => ({ direction: "add" as const, amount: cop(1n), reason: "Bono" }));
    expect(() => computeSettlement({ ...base, commissions: [line(1n, 1_000n)], adjustments: many })).toThrow("Máximo 10");
  });

  it("nada pendiente: no hay nada que liquidar", () => {
    expect(() => computeSettlement(base)).toThrow("No hay nada que liquidar");
    expect(() => computeSettlement({ ...base, receivable: cop(5_000n) })).toThrow("No hay nada que liquidar");
  });
});

describe("corte, reversa y motivo", () => {
  it("el corte no es futuro ni anterior al último", () => {
    expect(() => assertCutoff({ cutoffDate: "2026-11-16", today: "2026-11-15", lastCutoffDate: null })).toThrow("La fecha de corte no puede ser futura");
    expect(() => assertCutoff({ cutoffDate: "2026-11-01", today: "2026-11-15", lastCutoffDate: "2026-11-02" })).toThrow(
      "La fecha de corte no puede ser anterior a la última liquidación",
    );
    expect(() => assertCutoff({ cutoffDate: "2026-11-02", today: "2026-11-15", lastCutoffDate: "2026-11-02" })).not.toThrow();
    expect(() => assertCutoff({ cutoffDate: "2026-11-15", today: "2026-11-15", lastCutoffDate: null })).not.toThrow();
  });

  it("solo se revierte la última vigente, una vez", () => {
    expect(() => assertReversible({ status: "reversed", number: 3n, latestActiveNumber: 2n })).toThrow("Esta liquidación ya está revertida");
    expect(() => assertReversible({ status: "settled", number: 3n, latestActiveNumber: 4n, staffName: "Andrés" })).toThrow(
      "Solo se puede revertir la última liquidación de Andrés (N.º 0004)",
    );
    expect(() => assertReversible({ status: "settled", number: 4n, latestActiveNumber: 4n })).not.toThrow();
  });

  it("motivo y número", () => {
    expect(requireSettlementReason("  Se pagó mal  ", "el motivo de la reversa")).toBe("Se pagó mal");
    expect(() => requireSettlementReason(undefined, "el motivo del anticipo")).toThrow("Escribe el motivo del anticipo");
    expect(receiptNumberLabel(12n)).toBe("N.º 0012");
    expect(receiptNumberLabel(12345n)).toBe("N.º 12345");
  });

  it("anticipo: cuadra, de la caja o del banco", () => {
    const cash = staffAdvanceEntry(cop(20_000n), "cash", meta);
    assertValidEntry(cash);
    expect(cash.kind).toBe("staff_advance");
    expect(nets(cash)).toEqual({ "1365": cop(20_000n).minor, "1105": -cop(20_000n).minor });
    expect(nets(staffAdvanceEntry(cop(20_000n), "bank", meta))).toEqual({ "1365": cop(20_000n).minor, "1110": -cop(20_000n).minor });
    expect(() => staffAdvanceEntry(money(150n), "cash", meta)).toThrow(SettlementError);
    expect(() => staffAdvanceEntry(cop(0n), "cash", meta)).toThrow(SettlementError);
  });
});

// ─── Propiedades ─────────────────────────────────────────────────────────────

const pesos = (max: bigint) => fc.bigInt({ min: 1n, max }).map((p) => cop(p));
const commissionArb = fc.array(pesos(500_000n), { maxLength: 8 });
const adjustmentArb = fc.array(
  fc.record({ direction: fc.constantFrom("add" as const, "deduct" as const), amount: pesos(200_000n), reason: fc.constant("Motivo") }),
  { maxLength: 4 },
);
const inputArb = fc
  .record({
    commissions: commissionArb,
    clawbacks: commissionArb,
    tipsOwed: fc.bigInt({ min: -30_000_000n, max: 30_000_000n }).map((m) => money(m)),
    includeTips: fc.boolean(),
    receivable: fc.bigInt({ min: 0n, max: 300_000n }).map((p) => cop(p)),
    adjustments: adjustmentArb,
    deductionShare: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
  })
  .map(
    (r): SettlementInput & { deductionShare?: number } => ({
      ...r,
      commissions: r.commissions.map((c, i) => line(BigInt(i + 1), c.minor / 100n)),
      clawbacks: r.clawbacks.map((c, i) => line(BigInt(i + 100), c.minor / 100n)),
      advanceDeduction: "max",
    }),
  );

function tryCompute(input: SettlementInput) {
  try {
    return computeSettlement(input);
  } catch (err) {
    if (err instanceof SettlementError && /No hay nada que liquidar/.test(err.message)) return null;
    throw err;
  }
}

const signOf = (m: Money) => (m.minor > 0n ? 1 : m.minor < 0n ? -1 : 0);

describe("liquidación: propiedades", () => {
  it("payout = C − V + T + J − D + K = Σ líneas; ≥ 0; D y K no positivos a la vez; pesos enteros", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const d = tryCompute(input);
        if (!d) return;
        const { commissionTotal: C, clawbackTotal: V, tips: T, adjustmentsTotal: J, advanceDeduction: D, carryOver: K, payout: P } = d;
        expect(P.minor).toBe(C.minor - V.minor + T.minor + J.minor - D.minor + K.minor);
        expect(P.minor).toBe(d.lines.reduce((a, l) => a + l.amount.minor, 0n));
        expect(P.minor >= 0n && C.minor >= 0n && V.minor >= 0n && D.minor >= 0n && K.minor >= 0n).toBe(true);
        expect(D.minor > 0n && K.minor > 0n).toBe(false);
        if (K.minor > 0n) expect(P.minor).toBe(0n);
        for (const m of [C, V, T, J, D, K, P]) expect(m.minor % 100n).toBe(0n);
        expect(d.lines.every((l) => l.amount.minor !== 0n)).toBe(true);
      }),
    );
  });

  it("el asiento cuadra y sus netos por cuenta son exactamente los de §3.1", () => {
    fc.assert(
      fc.property(inputArb, fc.constantFrom("cash" as const, "bank" as const), (input, source) => {
        const d = tryCompute(input);
        if (!d) return;
        const paidFrom = d.payout.minor === 0n ? null : source;
        const entry = settlementEntry(d, { ...meta, paidFrom });
        assertValidEntry(entry);
        const n = nets(entry);
        const expected: Record<string, bigint> = {
          "2335": d.commissionTotal.minor - d.clawbackTotal.minor,
          "2380": d.tips.minor,
          "5105": d.adjustmentsTotal.minor,
          "1365": d.carryOver.minor - d.advanceDeduction.minor,
          "1105": paidFrom === "cash" ? -d.payout.minor : 0n,
          "1110": paidFrom === "bank" ? -d.payout.minor : 0n,
        };
        for (const [code, value] of Object.entries(expected)) expect(n[code] ?? 0n, code).toBe(value);
        expect(Object.keys(n).every((code) => code in expected)).toBe(true);
      }),
    );
  });

  it("propinas: |debidas − T| < $1 y T tiene el signo de lo debido (o es 0)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const d = tryCompute(input);
        if (!d) return;
        if (input.includeTips || input.tipsOwed.minor < 0n) {
          const diff = input.tipsOwed.minor - d.tips.minor;
          expect(diff < 100n && diff > -100n).toBe(true);
        } else {
          expect(d.tips.minor).toBe(0n);
        }
        const s = signOf(d.tips);
        expect(s === 0 || s === signOf(input.tipsOwed)).toBe(true);
      }),
    );
  });

  it("D ≤ min(saldo por cobrar, max(G, 0)), también con un descuento elegido", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const d = tryCompute(input);
        if (!d) return;
        const cap = (g: bigint) => (input.receivable.minor < (g > 0n ? g : 0n) ? input.receivable.minor : g > 0n ? g : 0n);
        expect(d.advanceDeduction.minor).toBe(cap(d.gross.minor));
        if (input.deductionShare !== undefined) {
          const chosen = cop((cap(d.gross.minor) / 100n) * BigInt(input.deductionShare) / 100n);
          const e = computeSettlement({ ...input, advanceDeduction: chosen });
          expect(e.advanceDeduction).toEqual(chosen);
          expect(e.advanceDeduction.minor <= cap(e.gross.minor)).toBe(true);
          expect(e.payout.minor).toBe(e.gross.minor >= 0n ? e.gross.minor - chosen.minor : 0n);
        }
      }),
    );
  });

  it("anticipo: el asiento cuadra para cualquier monto en pesos enteros", () => {
    fc.assert(
      fc.property(pesos(10n ** 11n), fc.constantFrom("cash" as const, "bank" as const), (amount, from) => {
        assertValidEntry(staffAdvanceEntry(amount, from, meta));
      }),
    );
  });
});
