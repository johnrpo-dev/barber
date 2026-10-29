"use client";

import { type ReactNode, useEffect, useState } from "react";
import type { ActionResult } from "@/lib/action";
import { Btn } from "@/app/panel/_components/ui";
import { type DayCount, longDate, plural, safeCall, type SlotView, weekdayDay, weekdayName } from "../_lib/ui";
import { DayStrip } from "./day-strip";
import { SlotGroups } from "./slot-groups";

// Día + hora: DayStrip, el anuncio del conteo y los grupos de horarios, con sus estados vacíos
// y de error. Lo usan la reserva y la reprogramación; cada una inyecta sus propias acciones.

type Loaded<T> = { key: string; value: T; error: string | null };

export function SlotChooser({
  daysKey,
  loadDays,
  loadSlots,
  today,
  date,
  onDateChange,
  value,
  onChange,
  reloadToken = 0,
  noDaysMessage,
  emptyActions,
}: {
  /** Cambia cuando cambia lo que determina los días (servicio, barbero, cita). */
  daysKey: string;
  loadDays: () => Promise<ActionResult<{ days: DayCount[] }>>;
  loadSlots: (date: string) => Promise<ActionResult<{ slots: SlotView[] }>>;
  today: string;
  date: string | null;
  onDateChange: (date: string) => void;
  value: number | null;
  onChange: (slot: SlotView | null) => void;
  /** Súbelo para recargar días y horarios (p. ej. cuando alguien tomó el horario elegido). */
  reloadToken?: number;
  noDaysMessage: string;
  /** Acciones extra en los estados vacíos (p. ej. "Probar con Cualquiera"). */
  emptyActions?: ReactNode;
}) {
  const [daysAttempt, setDaysAttempt] = useState(0);
  const [slotsAttempt, setSlotsAttempt] = useState(0);
  const [days, setDays] = useState<Loaded<DayCount[]> | null>(null);
  const [slots, setSlots] = useState<Loaded<SlotView[]> | null>(null);

  const dKey = `${daysKey}|${reloadToken}|${daysAttempt}`;
  const sKey = `${dKey}|${date ?? ""}|${slotsAttempt}`;

  useEffect(() => {
    let alive = true;
    safeCall(loadDays).then((r) => {
      if (!alive) return;
      setDays(r.ok ? { key: dKey, value: r.data.days, error: null } : { key: dKey, value: [], error: r.error });
    });
    return () => {
      alive = false;
    };
    // Las funciones de carga cambian en cada render; lo que importa es la clave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dKey]);

  const currentDays = days?.key === dKey ? days : null;

  // Arranca en el primer día con horarios (o salta a él si el elegido se llenó).
  useEffect(() => {
    if (!currentDays || currentDays.error) return;
    const stillOpen = currentDays.value.some((d) => d.date === date && d.count > 0);
    if (stillOpen) return;
    const first = currentDays.value.find((d) => d.count > 0);
    if (first && first.date !== date) onDateChange(first.date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDays]);

  useEffect(() => {
    if (!date || !currentDays || currentDays.error) return;
    let alive = true;
    safeCall(() => loadSlots(date)).then((r) => {
      if (!alive) return;
      setSlots(r.ok ? { key: sKey, value: r.data.slots, error: null } : { key: sKey, value: [], error: r.error });
      if (r.ok && value !== null && !r.data.slots.some((s) => s.minute === value)) onChange(null);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sKey, currentDays]);

  const currentSlots = slots?.key === sKey ? slots : null;
  const anyDay = currentDays?.value.some((d) => d.count > 0) ?? false;
  const nextOpen = date ? currentDays?.value.find((d) => d.date > date && d.count > 0) : undefined;

  let status: string;
  if (!currentDays) status = "Cargando horarios…";
  else if (currentDays.error) status = "";
  else if (!anyDay) status = noDaysMessage;
  else if (!date || !currentSlots) status = "Cargando horarios…";
  else if (currentSlots.error) status = "";
  else if (currentSlots.value.length === 0) status = `No quedan horarios el ${weekdayDay(date)}.`;
  else status = `${plural(currentSlots.value.length, "horario disponible", "horarios disponibles")} el ${longDate(date)}`;

  const error = currentDays?.error ?? currentSlots?.error ?? null;

  return (
    <div className="flex flex-col gap-4">
      {currentDays && !currentDays.error && anyDay ? (
        <DayStrip days={currentDays.value} value={date} onChange={onDateChange} today={today} />
      ) : null}

      <p role="status" className="text-sm font-medium text-tinta/80">
        {status}
      </p>

      {error ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-alerta/30 bg-alerta/5 p-4 text-sm font-medium text-alerta">
          <p>{error}</p>
          <Btn
            variant="secondary"
            size="sm"
            className="h-11"
            onPress={() => (currentDays?.error ? setDaysAttempt((n) => n + 1) : setSlotsAttempt((n) => n + 1))}
          >
            Reintentar
          </Btn>
        </div>
      ) : null}

      {currentDays && !currentDays.error && !anyDay ? (
        emptyActions ? <div className="flex flex-wrap gap-2">{emptyActions}</div> : null
      ) : null}

      {date && currentDays && !currentDays.error && anyDay && !currentSlots ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-hidden>
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-tinta/5" />
          ))}
        </div>
      ) : null}

      {date && currentSlots && !currentSlots.error ? (
        currentSlots.value.length > 0 ? (
          <SlotGroups slots={currentSlots.value} value={value} onChange={onChange} />
        ) : !nextOpen && !emptyActions ? null : (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-tinta/25 p-4">
            {nextOpen ? (
              <>
                <p className="text-sm">
                  El {weekdayDay(nextOpen.date)} tiene {plural(nextOpen.count, "horario", "horarios")}.
                </p>
                <Btn variant="secondary" size="md" onPress={() => onDateChange(nextOpen.date)}>
                  Ver {weekdayName(nextOpen.date)}
                </Btn>
              </>
            ) : null}
            {emptyActions ? <div className="flex flex-wrap gap-2">{emptyActions}</div> : null}
          </div>
        )
      ) : null}
    </div>
  );
}
