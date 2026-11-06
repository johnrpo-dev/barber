import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays } from "../booking/clock";
import { fromUnits } from "../money";
import {
  cleanSkipReason,
  dueDateOf,
  duePeriods,
  dueStatusLabel,
  isPeriodOf,
  monthIndex,
  monthStart,
  nextDueDate,
  periodLabel,
  RECURRING_LEAD_DAYS,
  type RecurringSchedule,
  RecurringExpenseError,
  recurringIdempotencyKey,
  scheduleLabel,
  validateRecurringDraft,
} from "./recurring";

// Gastos fijos (docs/sprint-8-gastos-controles.md §5): qué periodos se muestran como vencidos o por
// vencer. Fechas de calendario del día local de la sede; nada se asienta solo.

const monthly = (over: Partial<RecurringSchedule> = {}): RecurringSchedule => ({
  startMonth: "2026-09-01",
  intervalMonths: 1,
  dayOfMonth: 5,
  active: true,
  ...over,
});

const periods = (s: RecurringSchedule, today: string, done: string[] = []) => duePeriods(s, { today, registeredOrSkipped: done }).map((p) => p.period);

describe("duePeriods: ejemplos", () => {
  it("aparece 3 días antes del vencimiento, no 4", () => {
    const s = monthly({ startMonth: "2026-11-01" });
    expect(periods(s, "2026-11-01")).toEqual([]);
    expect(duePeriods(s, { today: "2026-11-02", registeredOrSkipped: [] })).toEqual([
      { period: "2026-11-01", dueDate: "2026-11-05", status: "upcoming", days: 3 },
    ]);
  });

  it("vence hoy y luego queda vencido hasta que se registra u omite", () => {
    const s = monthly({ startMonth: "2026-11-01" });
    expect(duePeriods(s, { today: "2026-11-05", registeredOrSkipped: [] })[0]).toMatchObject({ status: "due_today", days: 0 });
    expect(duePeriods(s, { today: "2026-11-20", registeredOrSkipped: [] })[0]).toMatchObject({ status: "overdue", days: 15 });
    expect(periods(s, "2026-11-20", ["2026-11-01"])).toEqual([]);
  });

  it("los vencidos se acumulan: septiembre y octubre sin pagar siguen ahí en noviembre", () => {
    expect(periods(monthly(), "2026-11-03", ["2026-10-01"])).toEqual(["2026-09-01", "2026-11-01"]);
  });

  it("cada 2 meses desde septiembre: septiembre, noviembre, enero", () => {
    const s = monthly({ intervalMonths: 2 });
    expect(periods(s, "2027-01-10")).toEqual(["2026-09-01", "2026-11-01", "2027-01-01"]);
  });

  it("cruza el año con el día 28", () => {
    const s = monthly({ startMonth: "2026-12-01", dayOfMonth: 28 });
    expect(periods(s, "2026-12-25")).toEqual(["2026-12-01"]);
    expect(periods(s, "2027-01-24")).toEqual(["2026-12-01"]);
    expect(periods(s, "2027-01-25")).toEqual(["2026-12-01", "2027-01-01"]);
  });

  it("el día 1 aparece desde el 29 del mes anterior", () => {
    const s = monthly({ startMonth: "2026-12-01", dayOfMonth: 1 });
    expect(periods(s, "2026-11-27")).toEqual([]);
    expect(periods(s, "2026-11-28")).toEqual(["2026-12-01"]);
  });

  it("nunca antes del mes de inicio, y una plantilla pausada no muestra nada", () => {
    expect(periods(monthly({ startMonth: "2027-03-01" }), "2026-11-20")).toEqual([]);
    expect(periods(monthly({ active: false }), "2026-11-20")).toEqual([]);
  });

  it("el próximo vencimiento es el primero que aún no aparece", () => {
    expect(nextDueDate(monthly(), "2026-11-03")).toBe("2026-12-05");
    expect(nextDueDate(monthly({ startMonth: "2027-03-01", intervalMonths: 3 }), "2026-11-03")).toBe("2027-03-05");
    expect(nextDueDate(monthly({ active: false }), "2026-11-03")).toBeNull();
  });

  it("rechaza plantillas imposibles", () => {
    expect(() => duePeriods(monthly({ dayOfMonth: 29 }), { today: "2026-11-01", registeredOrSkipped: [] })).toThrow(RecurringExpenseError);
    expect(() => duePeriods(monthly({ intervalMonths: 0 }), { today: "2026-11-01", registeredOrSkipped: [] })).toThrow(RecurringExpenseError);
    expect(() => duePeriods(monthly({ startMonth: "2026-11-02" }), { today: "2026-11-01", registeredOrSkipped: [] })).toThrow(RecurringExpenseError);
    expect(() => duePeriods(monthly(), { today: "2026-02-30", registeredOrSkipped: [] })).toThrow(RecurringExpenseError);
  });

  it("etiquetas y clave de idempotencia", () => {
    expect(periodLabel("2026-11-01")).toBe("noviembre de 2026");
    expect(scheduleLabel({ intervalMonths: 1, dayOfMonth: 5 })).toBe("Cada mes, el día 5");
    expect(scheduleLabel({ intervalMonths: 3, dayOfMonth: 15 })).toBe("Cada 3 meses, el día 15");
    expect(dueStatusLabel({ status: "overdue", days: 1 })).toBe("Vencido hace 1 día");
    expect(dueStatusLabel({ status: "upcoming", days: 2 })).toBe("Vence en 2 días");
    expect(dueStatusLabel({ status: "due_today", days: 0 })).toBe("Vence hoy");
    expect(recurringIdempotencyKey(12n, "2026-11-01")).toBe("recurring:12:2026-11-01");
  });
});

describe("validateRecurringDraft", () => {
  const draft = {
    name: "  Arriendo   del local ",
    estimatedAmount: fromUnits(2_500_000n),
    payMode: "bank" as const,
    dayOfMonth: 5,
    intervalMonths: 1,
    startMonth: "2026-11-01",
    active: true,
  };

  it("limpia el nombre y acepta una plantilla válida", () => {
    expect(validateRecurringDraft(draft, { today: "2026-11-06" })).toEqual({ name: "Arriendo del local" });
  });

  it("rechaza montos sin pesos enteros, cero o negativos", () => {
    for (const minor of [0n, -100n, 150n]) {
      expect(() => validateRecurringDraft({ ...draft, estimatedAmount: { minor } as never }, { today: "2026-11-06" })).toThrow(RecurringExpenseError);
    }
  });

  it("el mes de inicio se acota a ±12 meses solo si cambia", () => {
    expect(() => validateRecurringDraft({ ...draft, startMonth: "2025-10-01" }, { today: "2026-11-06" })).toThrow(/12 meses/);
    expect(validateRecurringDraft({ ...draft, startMonth: "2025-11-01" }, { today: "2026-11-06" })).toEqual({ name: "Arriendo del local" });
    expect(validateRecurringDraft({ ...draft, startMonth: "2024-01-01" }, { today: "2026-11-06", previousStartMonth: "2024-01-01" })).toEqual({
      name: "Arriendo del local",
    });
  });

  it("el motivo de una omisión es de 3 a 300 caracteres en una línea", () => {
    expect(cleanSkipReason("  Se pagó\nen octubre ")).toBe("Se pagó en octubre");
    expect(() => cleanSkipReason(" no ")).toThrow(RecurringExpenseError);
    expect(() => cleanSkipReason("x".repeat(301))).toThrow(RecurringExpenseError);
    // Un carácter de control que no es espacio se rechaza con un mensaje claro (la base lo rechazaría con un CHECK).
    expect(() => cleanSkipReason("Se pagó \x07 antes")).toThrow(new RecurringExpenseError("El motivo tiene caracteres no válidos"));
    expect(() => validateRecurringDraft({ ...draft, name: "Agua\x07" }, { today: "2026-11-06" })).toThrow(/caracteres no válidos/);
  });
});

// ─── Propiedades ─────────────────────────────────────────────────────────────

/** Un día cualquiera entre 2024 y 2030. */
const dayArb = fc.integer({ min: 0, max: 6 * 365 }).map((n) => addDays("2024-01-01", n));
const scheduleArb: fc.Arbitrary<RecurringSchedule> = fc.record({
  startMonth: fc.integer({ min: monthIndex("2024-01-01"), max: monthIndex("2030-12-01") }).map(monthStart),
  intervalMonths: fc.integer({ min: 1, max: 12 }),
  dayOfMonth: fc.integer({ min: 1, max: 28 }),
  active: fc.constant(true),
});
/** Periodos ya registrados u omitidos: algunos de la plantilla y algún ruido. */
const doneArb = (s: RecurringSchedule) =>
  fc.array(fc.integer({ min: 0, max: 40 }).map((k) => monthStart(monthIndex(s.startMonth) + k * s.intervalMonths)), { maxLength: 10 });

const withDone = scheduleArb.chain((s) => fc.tuple(fc.constant(s), dayArb, doneArb(s)));

describe("duePeriods: propiedades", () => {
  it("nunca repite un periodo y van en orden", () => {
    fc.assert(
      fc.property(withDone, ([s, today, done]) => {
        const list = periods(s, today, done);
        expect(new Set(list).size).toBe(list.length);
        expect([...list].sort()).toEqual(list);
      }),
    );
  });

  it("respeta el intervalo y nunca va antes del mes de inicio", () => {
    fc.assert(
      fc.property(withDone, ([s, today, done]) => {
        for (const p of periods(s, today, done)) {
          expect(p >= s.startMonth).toBe(true);
          expect((monthIndex(p) - monthIndex(s.startMonth)) % s.intervalMonths).toBe(0);
          expect(isPeriodOf(s, p)).toBe(true);
        }
      }),
    );
  });

  it(`no adelanta más de ${RECURRING_LEAD_DAYS} días`, () => {
    fc.assert(
      fc.property(withDone, ([s, today, done]) => {
        for (const d of duePeriods(s, { today, registeredOrSkipped: done })) {
          expect(d.dueDate <= addDays(today, RECURRING_LEAD_DAYS)).toBe(true);
          expect(d.dueDate).toBe(dueDateOf(s, d.period));
        }
      }),
    );
  });

  it("no muestra lo registrado u omitido, y muestra todo lo demás que ya toca", () => {
    fc.assert(
      fc.property(withDone, ([s, today, done]) => {
        const list = new Set(periods(s, today, done));
        for (const p of done) expect(list.has(p)).toBe(false);
        // Completo: todo periodo de la plantilla con vencimiento dentro del aviso y sin registrar está.
        for (let k = 0; k < 120; k++) {
          const p = monthStart(monthIndex(s.startMonth) + k * s.intervalMonths);
          if (dueDateOf(s, p) > addDays(today, RECURRING_LEAD_DAYS)) break;
          if (!done.includes(p)) expect(list.has(p)).toBe(true);
        }
      }),
    );
  });

  it("un periodo vencido sigue apareciendo días después hasta que se registra u omite", () => {
    fc.assert(
      fc.property(withDone, fc.integer({ min: 0, max: 800 }), ([s, today, done], later) => {
        const before = periods(s, today, done);
        const after = new Set(periods(s, addDays(today, later), done));
        for (const p of before) expect(after.has(p)).toBe(true);
        // Y desaparece en cuanto se registra u omite.
        if (before.length > 0) expect(periods(s, addDays(today, later), [...done, before[0]!])).not.toContain(before[0]);
      }),
    );
  });

  it("el estado coincide con la fecha: vencido, vence hoy o por vencer (a lo sumo 3 días)", () => {
    fc.assert(
      fc.property(withDone, ([s, today, done]) => {
        for (const d of duePeriods(s, { today, registeredOrSkipped: done })) {
          if (d.status === "overdue") expect(d.dueDate < today && d.days > 0).toBe(true);
          if (d.status === "due_today") expect(d.dueDate).toBe(today);
          if (d.status === "upcoming") expect(d.dueDate > today && d.days >= 1 && d.days <= RECURRING_LEAD_DAYS).toBe(true);
        }
      }),
    );
  });

  it("el próximo vencimiento queda justo fuera del aviso y es de la plantilla", () => {
    fc.assert(
      fc.property(scheduleArb, dayArb, (s, today) => {
        const next = nextDueDate(s, today)!;
        expect(next > addDays(today, RECURRING_LEAD_DAYS)).toBe(true);
        expect(isPeriodOf(s, `${next.slice(0, 7)}-01`)).toBe(true);
      }),
    );
  });
});
