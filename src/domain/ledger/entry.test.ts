import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocate, fromUnits, money, PESO, percentOf } from "../money";
import { ACCOUNTS, type AccountCode, CHART_OF_ACCOUNTS } from "./accounts";
import { businessDate } from "./business-date";
import {
  assertValidEntry,
  InvalidEntryError,
  type JournalEntryDraft,
  type LedgerLine,
  netByAccount,
  reversalOf,
  UnbalancedEntryError,
} from "./entry";

const codes = CHART_OF_ACCOUNTS.map((a) => a.code as AccountCode);

/** Genera asientos balanceados arbitrarios: el total se reparte con allocate() en ambos lados. */
const balancedEntry = fc
  .record({
    total: fc.bigInt({ min: 1n, max: 10n ** 11n }),
    debitAccounts: fc.array(fc.constantFrom(...codes), { minLength: 1, maxLength: 4 }),
    creditAccounts: fc.array(fc.constantFrom(...codes), { minLength: 1, maxLength: 4 }),
    debitWeights: fc.array(fc.bigInt({ min: 1n, max: 100n }), { minLength: 4, maxLength: 4 }),
    creditWeights: fc.array(fc.bigInt({ min: 1n, max: 100n }), { minLength: 4, maxLength: 4 }),
  })
  .map(({ total, debitAccounts, creditAccounts, debitWeights, creditWeights }): JournalEntryDraft => {
    const side = (accounts: AccountCode[], weights: bigint[], s: "debit" | "credit"): LedgerLine[] =>
      allocate(money(total), weights.slice(0, accounts.length))
        .map((amount, i) => ({ account: accounts[i]!, side: s, amount }))
        .filter((l) => l.amount.minor > 0n);
    return {
      businessDate: "2026-10-28",
      kind: "sale",
      memo: "generado",
      lines: [...side(debitAccounts, debitWeights, "debit"), ...side(creditAccounts, creditWeights, "credit")],
    };
  })
  .filter((e) => e.lines.length >= 2);

describe("asientos de partida doble", () => {
  it("un corte de $25.000 cobrado mitad efectivo y mitad tarjeta, con propina y comisión del 40 %", () => {
    const price = fromUnits(25_000n);
    const [cash, card] = allocate(price, [1n, 1n]) as [typeof price, typeof price];
    const tip = fromUnits(5_000n);
    const commission = percentOf(price, 4_000n, PESO);

    const entry: JournalEntryDraft = {
      businessDate: "2026-10-28",
      kind: "sale",
      memo: "Corte clásico — Andrés",
      lines: [
        { account: ACCOUNTS.cash.code, side: "debit", amount: cash },
        { account: ACCOUNTS.bank.code, side: "debit", amount: money(card.minor + tip.minor) },
        { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: price },
        { account: ACCOUNTS.tipsPayable.code, side: "credit", amount: tip },
        { account: ACCOUNTS.commissionExpense.code, side: "debit", amount: commission },
        { account: ACCOUNTS.commissionsPayable.code, side: "credit", amount: commission },
      ],
    };

    expect(() => assertValidEntry(entry)).not.toThrow();
    expect(commission).toEqual(fromUnits(10_000n));
    // La propina no es ingreso de la barbería: queda como deuda con el barbero.
    expect(netByAccount(entry.lines).get(ACCOUNTS.serviceIncome.code)?.minor).toBe(-price.minor);
    expect(netByAccount(entry.lines).get(ACCOUNTS.tipsPayable.code)?.minor).toBe(-tip.minor);
  });

  it("rechaza un asiento descuadrado por un peso", () => {
    const entry: JournalEntryDraft = {
      businessDate: "2026-10-28",
      kind: "expense",
      memo: "Arriendo",
      lines: [
        { account: ACCOUNTS.generalExpense.code, side: "debit", amount: fromUnits(1_000_000n) },
        { account: ACCOUNTS.bank.code, side: "credit", amount: fromUnits(999_999n) },
      ],
    };
    expect(() => assertValidEntry(entry)).toThrow(UnbalancedEntryError);
  });

  it.each([
    ["una sola línea", [{ account: ACCOUNTS.cash.code, side: "debit", amount: fromUnits(1n) }]],
    [
      "monto cero",
      [
        { account: ACCOUNTS.cash.code, side: "debit", amount: money(0n) },
        { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: money(0n) },
      ],
    ],
    [
      "monto negativo",
      [
        { account: ACCOUNTS.cash.code, side: "debit", amount: money(-100n) },
        { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: money(-100n) },
      ],
    ],
  ] as const)("rechaza %s", (_, lines) => {
    expect(() =>
      assertValidEntry({ businessDate: "2026-10-28", kind: "sale", memo: "x", lines: lines as readonly LedgerLine[] }),
    ).toThrow(InvalidEntryError);
  });

  it("rechaza un día contable mal formado", () => {
    expect(() =>
      assertValidEntry({
        businessDate: "28/10/2026",
        kind: "sale",
        memo: "x",
        lines: [
          { account: ACCOUNTS.cash.code, side: "debit", amount: fromUnits(1n) },
          { account: ACCOUNTS.serviceIncome.code, side: "credit", amount: fromUnits(1n) },
        ],
      }),
    ).toThrow(InvalidEntryError);
  });

  it("propiedad: todo asiento construido con allocate cuadra", () => {
    fc.assert(fc.property(balancedEntry, (entry) => assertValidEntry(entry)));
  });

  it("propiedad: asiento + su reversa deja todas las cuentas en cero", () => {
    fc.assert(
      fc.property(balancedEntry, (entry) => {
        const reversal = reversalOf(entry, "2026-10-29", "cobro equivocado");
        assertValidEntry(reversal);
        for (const net of netByAccount([...entry.lines, ...reversal.lines]).values()) {
          expect(net.minor).toBe(0n);
        }
      }),
    );
  });
});

describe("día contable", () => {
  it("10 p. m. en Bogotá sigue siendo el mismo día aunque en UTC ya sea mañana", () => {
    expect(businessDate(new Date("2026-10-29T03:00:00Z"), "America/Bogota")).toBe("2026-10-28");
  });

  it("medianoche en Bogotá ya es el día siguiente", () => {
    expect(businessDate(new Date("2026-10-29T05:00:00Z"), "America/Bogota")).toBe("2026-10-29");
  });
});
