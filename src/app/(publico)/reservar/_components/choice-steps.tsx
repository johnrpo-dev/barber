"use client";

import { Check, Clock, Users } from "lucide-react";
import { Radio, RadioGroup } from "react-aria-components";
import type { PortalView } from "../../data";
import { cx } from "../../_lib/ui";

// Pasos de elección: servicio y barbero. Elegir no avanza solo (las flechas del teclado también
// eligen); se sigue con "Continuar" en la barra inferior.

const card = ({ isSelected, isFocusVisible }: { isSelected: boolean; isFocusVisible: boolean }) =>
  cx(
    "flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors",
    isSelected ? "border-cuero bg-cuero/5 ring-1 ring-cuero" : "border-tinta/15 bg-papel hover:border-tinta/35",
    isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
  );

export function ServiceStep({
  services,
  value,
  onChange,
}: {
  services: PortalView["services"];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <RadioGroup aria-label="Servicio" value={value} onChange={onChange} className="grid gap-2 sm:grid-cols-2">
      {services.map((s) => (
        <Radio key={s.id} value={s.id} className={(r) => cx(card(r), "flex-col gap-1")}>
          {({ isSelected }) => (
            <>
              <span className="flex items-start justify-between gap-2">
                <span className="font-semibold leading-tight">{s.name}</span>
                {isSelected ? <Check size={18} className="shrink-0 text-cuero" aria-hidden /> : null}
              </span>
              <span className="flex items-center justify-between gap-2 text-sm text-tinta/70">
                <span className="flex items-center gap-1">
                  <Clock size={14} aria-hidden /> {s.durationMin} min
                </span>
                <span className="monto font-semibold text-tinta">{s.priceLabel}</span>
              </span>
            </>
          )}
        </Radio>
      ))}
    </RadioGroup>
  );
}

export function StaffStep({
  staff,
  value,
  onChange,
}: {
  staff: PortalView["staff"];
  value: string;
  onChange: (id: string) => void;
}) {
  const options = [
    { id: "any", name: "Cualquiera", initials: "", hint: "El primero que esté libre" },
    ...staff.map((p) => ({ ...p, hint: "" })),
  ];
  return (
    <RadioGroup aria-label="Barbero" value={value} onChange={onChange} className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => (
        <Radio key={o.id} value={o.id} className={(r) => cx(card(r), "min-h-16 items-center")}>
          {({ isSelected }) => (
            <>
              <span
                aria-hidden
                className={cx(
                  "grid h-11 w-11 shrink-0 place-items-center rounded-full text-sm font-semibold",
                  o.id === "any" ? "bg-tinta/10 text-tinta" : "bg-botella text-hueso",
                )}
              >
                {o.id === "any" ? <Users size={18} /> : o.initials}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{o.name}</span>
                {o.hint ? <span className="block text-sm text-tinta/70">{o.hint}</span> : null}
              </span>
              {isSelected ? <Check size={18} className="shrink-0 text-cuero" aria-hidden /> : null}
            </>
          )}
        </Radio>
      ))}
    </RadioGroup>
  );
}
