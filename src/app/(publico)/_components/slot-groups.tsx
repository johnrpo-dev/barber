"use client";

import { Radio, RadioGroup } from "react-aria-components";
import { cx, plural, type SlotView } from "../_lib/ui";

// Horarios de un día en tres grupos (Mañana / Tarde / Noche), cada uno con su conteo en el
// nombre accesible. Versión del portal: el panel conserva su propio slot-picker.

const PERIODS: { id: SlotView["period"]; label: string }[] = [
  { id: "morning", label: "Mañana" },
  { id: "afternoon", label: "Tarde" },
  { id: "evening", label: "Noche" },
];

export function SlotGroups({
  slots,
  value,
  onChange,
}: {
  slots: SlotView[];
  value: number | null;
  onChange: (slot: SlotView) => void;
}) {
  return (
    <RadioGroup
      aria-label="Hora"
      value={value === null ? null : String(value)}
      onChange={(v) => {
        const slot = slots.find((s) => String(s.minute) === v);
        if (slot) onChange(slot);
      }}
      className="flex flex-col gap-5"
    >
      {PERIODS.map((p) => {
        const items = slots.filter((s) => s.period === p.id);
        if (items.length === 0) return null;
        return (
          <div key={p.id} role="group" aria-label={`${p.label}, ${plural(items.length, "horario", "horarios")}`} className="flex flex-col gap-2">
            <p aria-hidden className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
              {p.label} <span className="font-normal normal-case tracking-normal">· {items.length}</span>
            </p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {items.map((s) => (
                <Radio
                  key={s.minute}
                  value={String(s.minute)}
                  className={({ isSelected, isFocusVisible }) =>
                    cx(
                      "monto grid h-12 cursor-pointer place-items-center whitespace-nowrap rounded-lg border px-1 text-sm font-semibold transition-colors",
                      isSelected ? "border-cuero bg-cuero text-hueso" : "border-tinta/15 bg-papel hover:border-tinta/40",
                      isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
                    )
                  }
                >
                  {s.label}
                </Radio>
              ))}
            </div>
          </div>
        );
      })}
    </RadioGroup>
  );
}
