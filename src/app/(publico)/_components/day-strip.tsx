"use client";

import { useEffect, useRef } from "react";
import { Radio, RadioGroup } from "react-aria-components";
import { cx, type DayCount, dayNumber, longDate, monthName, plural, weekdayShort } from "../_lib/ui";

// Tira de días: un RadioGroup horizontal. Las flechas cambian de día; los días sin horarios
// quedan deshabilitados (y fuera del recorrido del teclado) pero visibles, con su motivo.

export function DayStrip({
  days,
  value,
  onChange,
  today,
}: {
  days: DayCount[];
  value: string | null;
  onChange: (date: string) => void;
  today: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // El día elegido siempre a la vista (al arrancar en un día que no es el primero, o al volver).
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>("[data-selected]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);

  return (
    <RadioGroup
      ref={ref}
      aria-label="Día"
      orientation="horizontal"
      value={value}
      onChange={onChange}
      className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] motion-safe:scroll-smooth md:mx-0 md:grid md:grid-cols-7 md:px-0"
    >
      {days.map((d, i) => {
        const prev = days[i - 1];
        const showMonth = !prev || monthName(prev.date) !== monthName(d.date);
        const isToday = d.date === today;
        const status = d.count === 0 ? (d.closed ? "Cerrado" : "Lleno") : null;
        return (
          <div key={d.date} className="flex shrink-0 snap-start flex-col gap-1">
            <span aria-hidden className="h-4 text-xs font-semibold capitalize text-tinta/70">
              {showMonth ? monthName(d.date) : ""}
            </span>
            <Radio
              value={d.date}
              isDisabled={d.count === 0}
              aria-label={`${isToday ? "hoy, " : ""}${longDate(d.date)}, ${d.count === 0 ? "sin horarios" : plural(d.count, "horario", "horarios")}`}
              className={({ isSelected, isDisabled, isFocusVisible }) =>
                cx(
                  "flex h-[4.75rem] w-[3.75rem] cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl border transition-colors md:w-full",
                  isSelected
                    ? "border-cuero bg-cuero text-hueso"
                    : isDisabled
                      ? "cursor-default border-dashed border-tinta/25 bg-transparent text-tinta/70"
                      : "border-tinta/15 bg-papel hover:border-tinta/40",
                  isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
                )
              }
            >
              <span className="text-xs font-semibold tracking-wider">{isToday ? "HOY" : weekdayShort(d.date)}</span>
              <span className="monto font-display text-2xl leading-none">{dayNumber(d.date)}</span>
              {status ? <span className="text-[0.6875rem] font-medium leading-none">{status}</span> : null}
            </Radio>
          </div>
        );
      })}
    </RadioGroup>
  );
}

