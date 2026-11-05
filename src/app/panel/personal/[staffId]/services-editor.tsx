"use client";

import { useMemo, useState, useTransition } from "react";
import { Checkbox, CheckboxGroup, Label, Text } from "react-aria-components";
import { callAction } from "../../_components/money-field";
import { Btn, cx, useToast } from "../../_components/ui";
import { card, FormError } from "../../_manage/controls";
import { saveStaffServicesAction } from "../actions";

// Qué servicios hace una persona. Quien no hace un servicio no se ofrece para él en la agenda, en el
// walk-in ni en la reserva en línea. Las citas que ya tiene no cambian.

export interface ServiceChoiceView {
  id: string;
  name: string;
  durationLabel: string;
  priceLabel: string;
}

export function ServicesEditor({
  staffId,
  firstName,
  services,
  initial,
}: {
  staffId: string;
  firstName: string;
  services: ServiceChoiceView[];
  initial: string[];
}) {
  const toast = useToast();
  const [saved, setSaved] = useState(initial);
  const [selected, setSelected] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = useMemo(() => selected.length !== saved.length || selected.some((id) => !saved.includes(id)), [selected, saved]);

  function save() {
    setError(null);
    startTransition(async () => {
      const r = await callAction(() => saveStaffServicesAction({ staffId, serviceIds: selected }));
      if (!r.ok) return setError(r.error);
      setSaved(selected);
      toast("Servicios guardados");
    });
  }

  if (services.length === 0) {
    return <p className={cx(card, "p-5 text-sm text-tinta/70")}>Todavía no hay servicios en el catálogo.</p>;
  }

  const all = selected.length === services.length;
  return (
    <section className={cx(card, "flex flex-col gap-4 p-5")}>
      <CheckboxGroup value={selected} onChange={setSelected} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <Label className="font-display text-xl">Servicios que hace</Label>
            <Text slot="description" className="max-w-prose text-sm text-tinta/70">
              {firstName} solo aparece para estos servicios en la agenda y en la reserva en línea. Las citas que ya tiene no cambian.
            </Text>
          </div>
          <Btn variant="ghost" size="sm" className="h-11" onPress={() => setSelected(all ? [] : services.map((s) => s.id))}>
            {all ? "Quitar todos" : "Marcar todos"}
          </Btn>
        </div>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {services.map((s) => (
            <Checkbox
              key={s.id}
              value={s.id}
              className="group flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm outline-none hover:bg-tinta/5"
            >
              <span
                aria-hidden
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 border-tinta/50 group-data-[selected]:border-cuero group-data-[selected]:bg-cuero group-data-[focus-visible]:outline-3 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-cuero"
              >
                <svg viewBox="0 0 18 18" className="h-4 w-4 fill-none stroke-hueso stroke-[3] opacity-0 group-data-[selected]:opacity-100">
                  <polyline points="3 9.5 7 13.5 15 4.5" />
                </svg>
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-tinta/70">
                  <span className="monto">{s.durationLabel}</span> · <span className="monto">{s.priceLabel}</span>
                </span>
              </span>
            </Checkbox>
          ))}
        </div>
      </CheckboxGroup>
      {selected.length === 0 ? (
        <p className="text-sm font-medium text-alerta">Sin servicios, {firstName} no aparece para agendar ni en la reserva en línea.</p>
      ) : null}
      <FormError message={error} />
      <div className="flex items-center justify-end gap-3">
        <span className="monto text-sm text-tinta/70">
          {selected.length} de {services.length}
        </span>
        <Btn onPress={save} isDisabled={!dirty} isPending={pending}>
          Guardar servicios
        </Btn>
      </div>
    </section>
  );
}
