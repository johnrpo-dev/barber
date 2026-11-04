import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays } from "../booking/clock";
import { fromUnits, money, negate, ratioBps, truncateTo, PESO } from "../money";
import { CSV_MAX_ROWS, type CsvCell, csvFilename, csvMoney, csvText, toCsv } from "./csv";
import { assemblePnl, type AccountTotalRow } from "./pnl";
import { daysBetween, MAX_REPORT_DAYS, PERIOD_PRESETS, presetPeriod, ReportError, reportPeriod, sameDayLastWeek, sameSpanPreviousMonth } from "./period";
import { bpsLabel, changeLabel, rateBps } from "./rates";

// docs/sprint-5-comisiones-informes.md §6 y §11.

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** Analizador mínimo de CSV (";", comillas dobles, CRLF) para leer de vuelta lo que se exporta. */
function parseCsv(text: string): string[][] {
  expect(text.startsWith("﻿")).toBe(true);
  const s = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ";") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && s[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  expect(cell).toBe("");
  expect(row).toEqual([]);
  return rows;
}

const FORMULA = /^[=+\-@\t\r\n]/;
/** Lo que debe quedar en la celda: el texto tal cual, con un apóstrofo delante si empezaba como fórmula. */
const neutralized = (v: string) => (FORMULA.test(v) || FORMULA.test(v.replace(/^[\p{Z}\p{Cc}\p{Cf}]+/u, "")) ? `'${v}` : v);

describe("CSV", () => {
  it("formato: BOM, ';', CRLF, montos con coma y fechas ISO", () => {
    const csv = toCsv(["Fecha", "Concepto", "Valor"], [
      [{ date: "2026-11-15" }, { text: "Corte; barba" }, { money: fromUnits(27_000n) }],
      [{ date: "2026-11-15" }, { text: "=HYPERLINK(\"x\")" }, { money: money(-1_200_000n) }],
      [{ date: "2026-11-15" }, { text: "@SUM(A1)" }, { money: money(35_880n) }],
    ]);
    expect(csv).toBe(
      "﻿Fecha;Concepto;Valor\r\n2026-11-15;\"Corte; barba\";27000,00\r\n2026-11-15;\"'=HYPERLINK(\"\"x\"\")\";-12000,00\r\n2026-11-15;'@SUM(A1);358,80\r\n",
    );
  });

  it.each(["\u00a0=1+1", "\u200b=1+1", "\ufeff+1", "\u2003@x", " -1", "\u0001=1", "\u200e\u00a0=cmd"])("L1: una fórmula tras invisibles también se neutraliza (%j)", (value) => {
    expect(csvText(value).replace(/^"/, "").startsWith("'")).toBe(true);
  });

  it("L1: un texto normal con espacios al inicio queda igual", () => {
    expect(csvText("  Corte")).toBe("  Corte");
    expect(csvText("Corte =1")).toBe("Corte =1");
  });

  it("csvMoney: -12000,00, 358,80 y 0,05", () => {
    expect(csvMoney(money(-1_200_000n))).toBe("-12000,00");
    expect(csvMoney(money(35_880n))).toBe("358,80");
    expect(csvMoney(money(5n))).toBe("0,05");
    expect(csvMoney(money(-5n))).toBe("-0,05");
  });

  it("nombre del archivo", () => {
    expect(csvFilename("journal", { from: "2026-11-01", to: "2026-11-30" })).toBe("villa-libro-diario-2026-11-01-a-2026-11-30.csv");
  });

  it("tope de filas", () => {
    const rows = Array.from({ length: CSV_MAX_ROWS + 1 }, () => [{ count: 1n }] as CsvCell[]);
    expect(() => toCsv(["n"], rows)).toThrow(ReportError);
  });

  it("propiedad: el analizador recupera cada celda de texto y ninguna empieza por un carácter de fórmula", () => {
    const text = fc.string({ unit: fc.constantFrom("a", "ñ", "=", "+", "-", "@", "\t", "\r", "\n", ";", '"', " ", "'", "1") , maxLength: 12 });
    fc.assert(
      fc.property(fc.array(fc.array(text, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 5 }), (table) => {
        const width = table[0]!.length;
        const rows = table.map((r) => Array.from({ length: width }, (_, i) => ({ text: r[i] ?? "" })));
        const parsed = parseCsv(toCsv(Array.from({ length: width }, (_, i) => `c${i}`), rows));
        expect(parsed).toHaveLength(rows.length + 1);
        parsed.slice(1).forEach((r, i) => {
          r.forEach((v, j) => {
            expect(FORMULA.test(v)).toBe(false);
            expect(v).toBe(neutralized(rows[i]![j]!.text));
          });
        });
      }),
    );
  });

  it("propiedad: csvMoney cumple ^-?\\d+,\\d{2}$ y se lee de vuelta al mismo bigint", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (minor) => {
        const s = csvMoney(money(minor));
        expect(s).toMatch(/^-?\d+,\d{2}$/);
        const negative = s.startsWith("-");
        const [units, cents] = s.replace("-", "").split(",");
        const back = BigInt(units!) * 100n + BigInt(cents!);
        expect(negative ? -back : back).toBe(minor);
        expect(csvText(s)).toBe(minor < 0n ? `'${s}` : s); // una celda de texto con "-" sí se neutraliza
      }),
    );
  });
});

// ─── Estado de resultados ────────────────────────────────────────────────────

describe("estado de resultados", () => {
  const rows: AccountTotalRow[] = [
    { code: "4170", name: "Servicios", type: "income", debits: 1_200_000n, credits: 10_000_000n },
    { code: "5105", name: "Comisiones", type: "expense", debits: 4_000_000n, credits: 0n },
    { code: "5310", name: "Diferencias", type: "expense", debits: 0n, credits: 50_000n },
  ];

  it("da forma y verifica (5310 puede ser negativo)", () => {
    const pnl = assemblePnl(rows, { income: 8_800_000n, expenses: 3_950_000n, profit: 4_850_000n });
    expect(pnl.income.map((l) => l.amount.minor)).toEqual([8_800_000n]);
    expect(pnl.expenses.map((l) => [l.code, l.amount.minor])).toEqual([
      ["5105", 4_000_000n],
      ["5310", -50_000n],
    ]);
    expect(pnl.profit.minor).toBe(4_850_000n);
  });

  it("si filas y totales no cuadran, lanza", () => {
    expect(() => assemblePnl(rows, { income: 8_800_001n, expenses: 3_950_000n, profit: 4_850_001n })).toThrow(ReportError);
    expect(() => assemblePnl(rows, { income: 8_800_000n, expenses: 3_950_000n, profit: 1n })).toThrow(ReportError);
    expect(() => assemblePnl([{ code: "1105", name: "Caja", type: "asset", debits: 1n, credits: 0n }], { income: 0n, expenses: 0n, profit: 0n })).toThrow(
      ReportError,
    );
  });

  it("propiedad: utilidad = ingresos − gastos y Σ filas = totales", () => {
    const row = fc.record({
      code: fc.stringMatching(/^[45]\d{3}$/),
      debits: fc.bigInt({ min: 0n, max: 10n ** 12n }),
      credits: fc.bigInt({ min: 0n, max: 10n ** 12n }),
    });
    fc.assert(
      fc.property(fc.uniqueArray(row, { selector: (r) => r.code, maxLength: 8 }), (raw) => {
        const rs: AccountTotalRow[] = raw.map((r) => ({ ...r, name: r.code, type: r.code.startsWith("4") ? "income" : "expense" }));
        const income = rs.filter((r) => r.type === "income").reduce((a, r) => a + r.credits - r.debits, 0n);
        const expenses = rs.filter((r) => r.type === "expense").reduce((a, r) => a + r.debits - r.credits, 0n);
        const pnl = assemblePnl(rs, { income, expenses, profit: income - expenses });
        expect(pnl.profit.minor).toBe(pnl.totalIncome.minor - pnl.totalExpenses.minor);
        expect(pnl.income.reduce((a, l) => a + l.amount.minor, 0n)).toBe(income);
        expect(pnl.expenses.reduce((a, l) => a + l.amount.minor, 0n)).toBe(expenses);
        expect(() => assemblePnl(rs, { income: income + 1n, expenses, profit: income + 1n - expenses })).toThrow(ReportError);
      }),
    );
  });
});

// ─── Tasas ───────────────────────────────────────────────────────────────────

/** Referencia exacta con fracciones: round half-up (simétrico) de part/whole × 10.000. */
function referenceBps(part: bigint, whole: bigint): bigint {
  const num = part * 10_000n;
  const sign = num < 0n !== whole < 0n ? -1n : 1n;
  const n = num < 0n ? -num : num;
  const d = whole < 0n ? -whole : whole;
  const q = n / d;
  const r = n % d;
  return sign * (2n * r >= d ? q + 1n : q);
}

describe("tasas en puntos básicos", () => {
  it("ejemplos", () => {
    expect(ratioBps(fromUnits(1n), fromUnits(8n))).toBe(1_250n);
    expect(ratioBps(fromUnits(1n), fromUnits(0n))).toBeNull();
    expect(rateBps(1n, 3n)).toBe(3_333n);
    expect(rateBps(2n, 3n)).toBe(6_667n);
    expect(rateBps(0n, 0n)).toBeNull();
    expect(bpsLabel(1_250n)).toBe("12,5 %");
    expect(changeLabel(1_250n)).toBe("+12,5 %");
    expect(changeLabel(-305n)).toBe("-3,05 %");
    expect(changeLabel(0n)).toBe("0 %");
  });

  it("ratioBps y rateBps coinciden con la referencia exacta (half-up)", () => {
    const n = fc.bigInt({ min: -(10n ** 14n), max: 10n ** 14n });
    fc.assert(
      fc.property(n, n, (part, whole) => {
        const expected = whole === 0n ? null : referenceBps(part, whole);
        expect(ratioBps(money(part), money(whole))).toBe(expected);
        expect(rateBps(part, whole)).toBe(expected);
      }),
    );
  });

  it("truncateTo y negate", () => {
    expect(truncateTo(money(1_500_050n), PESO)).toEqual(money(1_500_000n));
    expect(truncateTo(money(-1_550n), PESO)).toEqual(money(-1_500n));
    expect(negate(money(5n))).toEqual(money(-5n));
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (m) => {
        const t = truncateTo(money(m), PESO).minor;
        expect(t % 100n).toBe(0n);
        expect(m - t < 100n && m - t > -100n).toBe(true);
        expect(t === 0n || t < 0n === m < 0n).toBe(true);
      }),
    );
  });
});

// ─── Periodo ─────────────────────────────────────────────────────────────────

describe("periodo", () => {
  it("valida", () => {
    expect(reportPeriod("2026-11-01", "2026-11-30")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(() => reportPeriod("2026-11-30", "2026-11-01")).toThrow(ReportError);
    expect(() => reportPeriod("2026-02-30", "2026-03-01")).toThrow(ReportError);
    expect(() => reportPeriod("2025-01-01", "2026-01-02")).toThrow(ReportError);
    expect(reportPeriod("2024-01-01", "2024-12-31").to).toBe("2024-12-31");
  });

  it("atajos", () => {
    expect(presetPeriod("this_week", "2026-11-15")).toEqual({ from: "2026-11-09", to: "2026-11-15" }); // domingo
    expect(presetPeriod("this_week", "2026-11-09")).toEqual({ from: "2026-11-09", to: "2026-11-15" }); // lunes
    expect(presetPeriod("last_month", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetPeriod("this_month", "2024-02-10")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(presetPeriod("this_year", "2026-11-15")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(sameDayLastWeek("2026-11-15")).toBe("2026-11-08");
    expect(sameSpanPreviousMonth("2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(sameSpanPreviousMonth("2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-15" });
    expect(sameSpanPreviousMonth("2026-01-10")).toEqual({ from: "2025-12-01", to: "2025-12-10" });
  });

  it("propiedad: from ≤ to, a lo sumo 366 días y contiene a hoy (salvo ayer y el mes anterior)", () => {
    const day = fc.integer({ min: 0, max: 365 * 30 }).map((n) => addDays("2010-01-01", n));
    fc.assert(
      fc.property(day, fc.constantFrom(...PERIOD_PRESETS), (today, preset) => {
        const p = presetPeriod(preset, today);
        expect(reportPeriod(p.from, p.to)).toEqual(p);
        expect(daysBetween(p.from, p.to) + 1 <= MAX_REPORT_DAYS).toBe(true);
        const contains = p.from <= today && today <= p.to;
        expect(contains).toBe(preset !== "yesterday" && preset !== "last_month");
        const s = sameSpanPreviousMonth(today);
        expect(s.from <= s.to && s.to < today.slice(0, 7) + "-01").toBe(true);
      }),
    );
  });
});
