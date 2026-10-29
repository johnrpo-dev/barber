"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { addDays } from "@/domain/booking/clock";
import { formatTime } from "@/domain/staff/schedule";
import { Btn, cx } from "../../_components/ui";
import { loadSlots, type SlotOption } from "../actions";

// Horarios libres de un día, agrupados en mañana / tarde / noche. El servidor calcula la
// disponibilidad; aquí solo se elige.

const LONG = new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

export function longDate(date: string): string {
  const label = LONG.format(new Date(`${date}T12:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function relativeDate(date: string, today: string): string {
  if (date === today) return "Hoy";
  if (date === addDays(today, 1)) return "Mañana";
  if (date === addDays(today, -1)) return "Ayer";
  return longDate(date);
}

const GROUPS = [
  { label: "Mañana", from: 0, to: 12 * 60 },
  { label: "Tarde", from: 12 * 60, to: 18 * 60 },
  { label: "Noche", from: 18 * 60, to: 24 * 60 },
];

type Load = { key: string; slots: SlotOption[]; error: string | null };

export function SlotPicker({
  serviceId,
  staffId,
  date,
  today,
  onDateChange,
  value,
  onChange,
  preferredMinute,
  excludeAppointmentId,
}: {
  serviceId: string;
  staffId: string;
  date: string;
  today: string;
  onDateChange: (date: string) => void;
  value: number | null;
  onChange: (minute: number | null, staffIds: string[]) => void;
  preferredMinute?: number | null;
  excludeAppointmentId?: string;
}) {
  const key = `${serviceId}|${staffId}|${date}|${excludeAppointmentId ?? ""}`;
  const [load, setLoad] = useState<Load | null>(null);

  useEffect(() => {
    let alive = true;
    loadSlots({ serviceId, staffId, date, excludeAppointmentId }).then((r) => {
      if (!alive) return;
      setLoad(r.ok ? { key, slots: r.data, error: null } : { key, slots: [], error: r.error });
      if (r.ok && preferredMinute != null) {
        const hit = r.data.find((s) => s.minute === preferredMinute);
        if (hit) onChange(hit.minute, hit.staffIds);
      }
    });
    return () => {
      alive = false;
    };
    // onChange/preferredMinute solo importan en la primera carga de cada combinación.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = load?.key === key ? load : null;
  const slots = current?.slots ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 rounded-xl border border-tinta/10 bg-hueso/60 p-1">
        <Btn
          variant="ghost"
          size="sm"
          className="h-11 w-11 px-0"
          aria-label="Día anterior"
          isDisabled={date <= today}
          onPress={() => onDateChange(addDays(date, -1))}
        >
          <ChevronLeft size={20} aria-hidden />
        </Btn>
        <p className="text-center text-sm font-semibold" aria-live="polite">
          {relativeDate(date, today)}
          {date === today || date === addDays(today, 1) ? (
            <span className="block text-xs font-normal text-tinta/70">{longDate(date)}</span>
          ) : null}
        </p>
        <Btn variant="ghost" size="sm" className="h-11 w-11 px-0" aria-label="Día siguiente" onPress={() => onDateChange(addDays(date, 1))}>
          <ChevronRight size={20} aria-hidden />
        </Btn>
      </div>

      {!current ? (
        <div className="grid grid-cols-4 gap-2" aria-busy="true" aria-label="Cargando horarios">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-tinta/5" />
          ))}
        </div>
      ) : current.error ? (
        <p role="alert" className="rounded-lg bg-alerta/5 p-3 text-sm text-alerta">
          {current.error}
        </p>
      ) : slots.length === 0 ? (
        <div className="rounded-xl border border-dashed border-tinta/20 p-6 text-center">
          <p className="font-semibold">No quedan horarios este día</p>
          <p className="mt-1 text-sm text-tinta/70">Prueba el día siguiente u otro barbero.</p>
          <Btn variant="secondary" size="sm" className="mt-3" onPress={() => onDateChange(addDays(date, 1))}>
            Ver {relativeDate(addDays(date, 1), today).toLowerCase()}
          </Btn>
        </div>
      ) : (
        <RadioGroup
          aria-label="Hora"
          value={value === null ? null : String(value)}
          onChange={(v) => {
            const slot = slots.find((s) => String(s.minute) === v);
            onChange(slot ? slot.minute : null, slot?.staffIds ?? []);
          }}
          className="flex flex-col gap-4"
        >
          {GROUPS.map((g) => {
            const items = slots.filter((s) => s.minute >= g.from && s.minute < g.to);
            if (items.length === 0) return null;
            return (
              <div key={g.label} className="flex flex-col gap-2">
                <Label className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
                  {g.label} <span className="font-normal normal-case tracking-normal">· {items.length}</span>
                </Label>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                  {items.map((s) => (
                    <Radio
                      key={s.minute}
                      value={String(s.minute)}
                      className={({ isSelected, isFocusVisible }) =>
                        cx(
                          "monto grid h-11 cursor-pointer place-items-center rounded-lg border text-sm font-semibold transition-colors",
                          isSelected ? "border-cuero bg-cuero text-hueso" : "border-tinta/15 bg-papel hover:border-tinta/40",
                          isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
                        )
                      }
                    >
                      {formatTime(s.minute)}
                    </Radio>
                  ))}
                </div>
              </div>
            );
          })}
        </RadioGroup>
      )}
    </div>
  );
}
