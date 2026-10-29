import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertValidWeeklySchedule, formatTime, InvalidScheduleError, parseTime, type ScheduleBlock, type Weekday } from "./schedule";

describe("horario semanal", () => {
  it("convierte horas a minutos y de vuelta", () => {
    expect(parseTime("09:30")).toBe(570);
    expect(parseTime("24:00")).toBe(1440);
    expect(formatTime(570)).toBe("09:30");
    expect(() => parseTime("9:30")).toThrow(InvalidScheduleError);
    expect(() => parseTime("25:00")).toThrow(InvalidScheduleError);
  });

  it("acepta jornada partida con almuerzo y bloques que se tocan", () => {
    const blocks: ScheduleBlock[] = [
      { weekday: 1, startMin: parseTime("14:00"), endMin: parseTime("19:00") },
      { weekday: 1, startMin: parseTime("09:00"), endMin: parseTime("14:00") },
      { weekday: 6, startMin: parseTime("08:00"), endMin: parseTime("16:00") },
    ];
    const sorted = assertValidWeeklySchedule(blocks);
    expect(sorted.map((b) => formatTime(b.startMin))).toEqual(["09:00", "14:00", "08:00"]);
  });

  it("rechaza bloques que se cruzan el mismo día", () => {
    expect(() =>
      assertValidWeeklySchedule([
        { weekday: 2, startMin: parseTime("09:00"), endMin: parseTime("13:00") },
        { weekday: 2, startMin: parseTime("12:30"), endMin: parseTime("18:00") },
      ]),
    ).toThrow(/se cruza/);
  });

  it.each([
    ["fin antes del inicio", { weekday: 1, startMin: 600, endMin: 540 }],
    ["minutos que no son múltiplo de 5", { weekday: 1, startMin: 541, endMin: 600 }],
    ["día 0", { weekday: 0, startMin: 540, endMin: 600 }],
    ["pasa de medianoche", { weekday: 1, startMin: 1380, endMin: 1500 }],
  ])("rechaza %s", (_, block) => {
    expect(() => assertValidWeeklySchedule([block as ScheduleBlock])).toThrow(InvalidScheduleError);
  });

  it("propiedad: bloques que se solapan siempre se rechazan; consecutivos siempre se aceptan", () => {
    // Inicio máximo 21:50: inicio + 100 min + 30 min del bloque siguiente no pasa de 24:00.
    const slot = fc.integer({ min: 0, max: 262 }).map((n) => n * 5);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }),
        slot,
        fc.integer({ min: 1, max: 20 }).map((n) => n * 5),
        fc.integer({ min: 1, max: 20 }).map((n) => n * 5),
        (day, start, len, overlap) => {
          const weekday = day as Weekday;
          const a = { weekday, startMin: start, endMin: start + len };
          const next = { weekday, startMin: a.endMin, endMin: a.endMin + 30 };
          expect(() => assertValidWeeklySchedule([a, next])).not.toThrow();
          const clash = { weekday, startMin: a.endMin - Math.min(overlap, len), endMin: a.endMin + 30 };
          expect(() => assertValidWeeklySchedule([a, clash])).toThrow(InvalidScheduleError);
        },
      ),
    );
  });
});
