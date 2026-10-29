"use client";

import { CopyCheck, Plus, Trash2 } from "lucide-react";
import { useId, useMemo, useRef, useState, useTransition } from "react";
import {
  assertValidWeeklySchedule,
  InvalidScheduleError,
  parseTime,
  WEEKDAY_LABELS,
  type Weekday,
} from "@/domain/staff/schedule";
import { Btn, cx, field, useToast } from "../../_components/ui";
import { card, Toggle } from "../../_manage/controls";
import { saveScheduleAction } from "../actions";

// Editor del horario semanal: una fila por día (lunes → domingo), con uno o más turnos.
// Se valida en vivo con la misma regla del dominio que aplica el servidor (assertValidWeeklySchedule).

export interface ScheduleBlockInput {
  weekday: Weekday;
  /** "HH:MM", hora local de la sede. */
  start: string;
  end: string;
}

type Block = { key: number; start: string; end: string };
type Day = { works: boolean; blocks: Block[] };
type Week = Record<Weekday, Day>;

const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];
const WORKWEEK: Weekday[] = [1, 2, 3, 4, 5];
const TIME = /^\d{2}:\d{2}$/;
const DEFAULT_BLOCK = { start: "09:00", end: "19:00" };

// Rango de la barra: 6:00 a 22:00.
const BAR_FROM = 6 * 60;
const BAR_TO = 22 * 60;

function toWeek(blocks: ScheduleBlockInput[], nextKey: () => number): Week {
  const week = {} as Week;
  for (const d of WEEKDAYS) {
    const own = blocks.filter((b) => b.weekday === d).map((b) => ({ key: nextKey(), start: b.start, end: b.end }));
    week[d] = { works: own.length > 0, blocks: own };
  }
  return week;
}

function toPayload(week: Week): ScheduleBlockInput[] {
  return WEEKDAYS.flatMap((d) =>
    week[d].works ? week[d].blocks.map((b) => ({ weekday: d, start: b.start, end: b.end })) : [],
  );
}

function dayError(weekday: Weekday, day: Day): string | null {
  if (!day.works) return null;
  if (day.blocks.length === 0) return "Agrega al menos un turno o marca que no trabaja.";
  if (day.blocks.some((b) => !TIME.test(b.start) || !TIME.test(b.end))) return "Completa las horas de cada turno.";
  try {
    assertValidWeeklySchedule(day.blocks.map((b) => ({ weekday, startMin: parseTime(b.start), endMin: parseTime(b.end) })));
    return null;
  } catch (err) {
    if (err instanceof InvalidScheduleError) return err.message;
    throw err;
  }
}

function minutesOf(block: Block): number {
  if (!TIME.test(block.start) || !TIME.test(block.end)) return 0;
  try {
    return Math.max(0, parseTime(block.end) - parseTime(block.start));
  } catch {
    return 0;
  }
}

function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function ScheduleEditor({ staffId, initial }: { staffId: string; initial: ScheduleBlockInput[] }) {
  const toast = useToast();
  const keyRef = useRef(0);
  const nextKey = () => ++keyRef.current;
  const [week, setWeek] = useState<Week>(() => toWeek(initial, nextKey));
  const [saved, setSaved] = useState(() => JSON.stringify(initial));
  const [pending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const payload = useMemo(() => toPayload(week), [week]);
  const dirty = JSON.stringify(payload) !== saved;
  const errors = useMemo(() => {
    const out: Partial<Record<Weekday, string>> = {};
    for (const d of WEEKDAYS) {
      const e = dayError(d, week[d]);
      if (e) out[d] = e;
    }
    return out;
  }, [week]);
  const hasErrors = Object.keys(errors).length > 0;
  const totalMinutes = WEEKDAYS.reduce(
    (acc, d) => acc + (week[d].works ? week[d].blocks.reduce((a, b) => a + minutesOf(b), 0) : 0),
    0,
  );
  const workDays = WEEKDAYS.filter((d) => week[d].works).length;

  function updateDay(d: Weekday, fn: (day: Day) => Day) {
    setServerError(null);
    setWeek((w) => ({ ...w, [d]: fn(w[d]) }));
  }

  function copyToWorkweek(from: Weekday) {
    setServerError(null);
    setWeek((w) => {
      const source = w[from];
      const next = { ...w };
      for (const d of WORKWEEK) {
        next[d] = { works: source.works, blocks: source.blocks.map((b) => ({ key: nextKey(), start: b.start, end: b.end })) };
      }
      return next;
    });
    toast(`Horario del ${WEEKDAY_LABELS[from].toLowerCase()} copiado a lunes–viernes. Recuerda guardar.`);
  }

  function save() {
    if (hasErrors) {
      toast("Revisa los días marcados antes de guardar.", "error");
      return;
    }
    startTransition(async () => {
      const res = await saveScheduleAction({ staffId, blocks: payload });
      if (!res.ok) {
        setServerError(res.error);
        toast(res.error, "error");
        return;
      }
      setSaved(JSON.stringify(payload));
      toast("Horario guardado");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-tinta/70">
        {workDays === 0 ? (
          "Sin horario: no aparece disponible en la agenda."
        ) : (
          <>
            Trabaja <span className="font-semibold text-tinta">{workDays} {workDays === 1 ? "día" : "días"}</span>,{" "}
            <span className="monto font-semibold text-tinta">{hoursLabel(totalMinutes)}</span> a la semana.
          </>
        )}
      </p>

      <ol className="flex flex-col gap-3">
        {WEEKDAYS.map((d) => (
          <DayRow
            key={d}
            weekday={d}
            day={week[d]}
            error={errors[d] ?? null}
            onChange={(fn) => updateDay(d, fn)}
            onCopy={() => copyToWorkweek(d)}
            newKey={nextKey}
          />
        ))}
      </ol>

      {serverError ? (
        <p role="alert" className={field.error}>
          {serverError}
        </p>
      ) : null}

      <div
        className={cx(
          "sticky bottom-20 z-10 flex items-center justify-between gap-3 rounded-xl border border-tinta/10 bg-papel/95 px-4 py-3 shadow-lg backdrop-blur lg:bottom-4",
          !dirty && "shadow-none",
        )}
      >
        <p className="text-sm text-tinta/70" aria-live="polite">
          {hasErrors ? "Hay días por corregir." : dirty ? "Cambios sin guardar." : "Todo guardado."}
        </p>
        <Btn variant="success" onPress={save} isPending={pending} isDisabled={!dirty}>
          {pending ? "Guardando…" : "Guardar horario"}
        </Btn>
      </div>
    </div>
  );
}

function DayRow({
  weekday,
  day,
  error,
  onChange,
  onCopy,
  newKey,
}: {
  weekday: Weekday;
  day: Day;
  error: string | null;
  onChange: (fn: (day: Day) => Day) => void;
  onCopy: () => void;
  newKey: () => number;
}) {
  const label = WEEKDAY_LABELS[weekday];
  const errorId = useId();

  function setWorks(works: boolean) {
    onChange((d) => ({ works, blocks: works && d.blocks.length === 0 ? [{ key: newKey(), ...DEFAULT_BLOCK }] : d.blocks }));
  }

  function addBlock() {
    onChange((d) => {
      const last = d.blocks[d.blocks.length - 1];
      // El turno nuevo arranca una hora después del último, para no cruzarse de entrada.
      let start = "14:00";
      let end = "19:00";
      if (last && TIME.test(last.end)) {
        try {
          const from = Math.min(parseTime(last.end) + 60, 23 * 60);
          const to = Math.min(from + 4 * 60, 23 * 60 + 55);
          start = `${String(Math.floor(from / 60)).padStart(2, "0")}:${String(from % 60).padStart(2, "0")}`;
          end = `${String(Math.floor(to / 60)).padStart(2, "0")}:${String(to % 60).padStart(2, "0")}`;
        } catch {
          // Hora inválida en el último turno: se usa el valor por defecto.
        }
      }
      return { ...d, blocks: [...d.blocks, { key: newKey(), start, end }] };
    });
  }

  function setBlock(key: number, patch: Partial<Block>) {
    onChange((d) => ({ ...d, blocks: d.blocks.map((b) => (b.key === key ? { ...b, ...patch } : b)) }));
  }

  function removeBlock(key: number) {
    onChange((d) => {
      const blocks = d.blocks.filter((b) => b.key !== key);
      return { works: blocks.length > 0 && d.works, blocks };
    });
  }

  return (
    <li className={cx(card, "flex flex-col gap-3 p-4", error && "border-alerta/40")}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{label}</h2>
        <Toggle isSelected={day.works} onChange={setWorks}>
          <span className={cx("w-16 text-right", day.works ? "text-botella" : "text-tinta/70")}>
            <span className="sr-only">{label}: </span>
            {day.works ? "Trabaja" : "Descansa"}
          </span>
        </Toggle>
      </div>

      <DayBar blocks={day.works ? day.blocks : []} />

      {day.works ? (
        <>
          <div className="flex flex-col gap-3">
            {day.blocks.map((b, i) => (
              <fieldset key={b.key} className="flex items-end gap-2">
                <legend className="sr-only">
                  {label}, turno {i + 1}
                </legend>
                <TimeBox label="Desde" value={b.start} onChange={(v) => setBlock(b.key, { start: v })} invalid={!!error} errorId={errorId} />
                <span aria-hidden className="pb-3 text-tinta/40">
                  –
                </span>
                <TimeBox label="Hasta" value={b.end} onChange={(v) => setBlock(b.key, { end: v })} invalid={!!error} errorId={errorId} />
                <Btn
                  variant="ghost"
                  className="h-12 w-12 shrink-0 px-0 text-tinta/70 hover:text-alerta"
                  aria-label={`Quitar turno ${i + 1} del ${label.toLowerCase()}`}
                  onPress={() => removeBlock(b.key)}
                >
                  <Trash2 size={18} aria-hidden />
                </Btn>
              </fieldset>
            ))}
          </div>

          {error ? (
            <p id={errorId} role="alert" className={field.error}>
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Btn variant="ghost" size="sm" className="h-11" onPress={addBlock} isDisabled={day.blocks.length >= 6}>
              <Plus size={16} aria-hidden />
              Agregar turno
            </Btn>
            <Btn
              variant="ghost"
              size="sm"
              className="h-11"
              onPress={onCopy}
              aria-label={`Copiar el horario del ${label.toLowerCase()} a lunes–viernes`}
            >
              <CopyCheck size={16} aria-hidden />
              Copiar a lunes–viernes
            </Btn>
          </div>
        </>
      ) : null}
    </li>
  );
}

function TimeBox({
  label,
  value,
  onChange,
  invalid,
  errorId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
  errorId: string;
}) {
  const id = useId();
  return (
    <div className={cx(field.root, "min-w-0 flex-1")}>
      <label htmlFor={id} className="text-xs font-semibold text-tinta/70">
        {label}
      </label>
      <input
        id={id}
        type="time"
        step={300}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        className={cx(field.input, "monto", invalid && "border-alerta")}
      />
    </div>
  );
}

/** Barra 6:00–22:00 con los turnos del día. Decorativa: la información ya está en los campos. */
function DayBar({ blocks }: { blocks: Block[] }) {
  const span = BAR_TO - BAR_FROM;
  return (
    <div aria-hidden className="flex flex-col gap-1">
      <div className="relative h-2.5 overflow-hidden rounded-full bg-tinta/5">
        {[12 * 60, 18 * 60].map((m) => (
          <span key={m} className="absolute inset-y-0 w-px bg-tinta/10" style={{ left: `${((m - BAR_FROM) / span) * 100}%` }} />
        ))}
        {blocks.map((b) => {
          if (!TIME.test(b.start) || !TIME.test(b.end)) return null;
          let s: number;
          let e: number;
          try {
            s = Math.max(parseTime(b.start), BAR_FROM);
            e = Math.min(parseTime(b.end), BAR_TO);
          } catch {
            return null;
          }
          if (e <= s) return null;
          return (
            <span
              key={b.key}
              className="absolute inset-y-0 rounded-full bg-botella/25"
              style={{ left: `${((s - BAR_FROM) / span) * 100}%`, width: `${((e - s) / span) * 100}%` }}
            />
          );
        })}
      </div>
      <div className="relative h-3 text-[10px] leading-none text-tinta/70">
        <span className="absolute left-0">6:00</span>
        {[12 * 60, 18 * 60].map((m) => (
          <span key={m} className="absolute -translate-x-1/2" style={{ left: `${((m - BAR_FROM) / span) * 100}%` }}>
            {m / 60}:00
          </span>
        ))}
        <span className="absolute right-0">22:00</span>
      </div>
    </div>
  );
}
