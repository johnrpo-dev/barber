"use client";

import { Check, ChevronRight, Clock, Users } from "lucide-react";
import { Button, Radio, RadioGroup } from "react-aria-components";
import type { PortalView } from "../../data";
import { cx } from "../../_lib/ui";

// Elecciones de la reserva. El servicio es una lista de botones: un toque elige y la reserva
// sigue sola (sin "Continuar"). El barbero es una fila de chips dentro del paso de la hora:
// cambiarlo recarga los horarios y no avanza (las flechas del teclado eligen sin saltar de paso).

export function ServiceStep({
  services,
  value,
  onPick,
}: {
  services: PortalView["services"];
  value: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <ul aria-label="Servicios" className="grid gap-2 sm:grid-cols-2">
      {services.map((s) => {
        const selected = s.id === value;
        return (
          <li key={s.id}>
            <Button
              onPress={() => onPick(s.id)}
              aria-pressed={selected}
              className={({ isFocusVisible }) =>
                cx(
                  "flex w-full cursor-pointer items-center gap-3 rounded-xl border p-4 text-left transition-colors",
                  selected ? "border-cuero bg-cuero/5 ring-1 ring-cuero" : "border-tinta/15 bg-papel hover:border-tinta/35",
                  isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
                )
              }
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="font-semibold leading-tight">{s.name}</span>
                <span className="flex items-center gap-3 text-sm text-tinta/70">
                  <span className="flex items-center gap-1">
                    <Clock size={14} aria-hidden /> {s.durationMin} min
                  </span>
                  <span className="monto font-semibold text-tinta">{s.priceLabel}</span>
                </span>
              </span>
              {selected ? <Check size={18} className="shrink-0 text-cuero" aria-hidden /> : <ChevronRight size={18} className="shrink-0 text-tinta/50" aria-hidden />}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function StaffPicker({
  staff,
  value,
  onChange,
}: {
  staff: PortalView["staff"];
  value: string;
  onChange: (id: string) => void;
}) {
  const options = [{ id: "any", name: "Cualquiera", initials: "" }, ...staff];
  return (
    <RadioGroup aria-label="Con quién" orientation="horizontal" value={value} onChange={onChange} className="flex flex-col gap-2">
      <span aria-hidden className="text-sm font-semibold">
        Con quién
      </span>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {options.map((o) => (
          <Radio
            key={o.id}
            value={o.id}
            className={({ isSelected, isFocusVisible }) =>
              cx(
                "inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full border py-1 pl-1 pr-3.5 text-sm font-semibold transition-colors",
                isSelected ? "border-cuero bg-cuero/10 ring-1 ring-cuero" : "border-tinta/15 bg-papel hover:border-tinta/40",
                isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
              )
            }
          >
            <span
              aria-hidden
              className={cx(
                "grid h-8 w-8 place-items-center rounded-full text-xs font-semibold",
                o.id === "any" ? "bg-tinta/10 text-tinta" : "bg-botella text-hueso",
              )}
            >
              {o.id === "any" ? <Users size={15} /> : o.initials}
            </span>
            {o.id === "any" ? o.name : o.name.split(/\s+/)[0]}
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}
