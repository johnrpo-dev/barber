"use client";

import { CalendarRange, Download } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { Form, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { daysBetween, MAX_REPORT_DAYS } from "@/domain/reports/period";
import { exportReportCsvAction } from "../informes/actions";
import { cx } from "./classes";
import { DateField } from "./date-field";
import { dayLabel } from "./dates";
import { callAction } from "./money-field";
import { Btn, useToast } from "./ui";
import { FormError } from "../_manage/controls";

// Controles de los historiales (ventas y caja): el periodo vive en la URL (?desde=&hasta=), así el
// servidor arma la página y se puede volver o compartir. El CSV lo arma el servidor
// (exportReportCsvAction, con su evento de auditoría); aquí solo se guarda con un Blob.

const CUSTOM = "custom";

export function PeriodBar({ period }: { period: { from: string; to: string; presets: { key: string; label: string; from: string; to: string }[] } }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const preset = period.presets.find((p) => p.from === period.from && p.to === period.to);
  const [custom, setCustom] = useState(!preset);
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const [error, setError] = useState<string | null>(null);

  const go = (p: { from: string; to: string }) => {
    setError(null);
    startTransition(() => router.push(`${pathname}?desde=${p.from}&hasta=${p.to}`));
  };

  function applyCustom(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!from || !to) return setError("Elige las dos fechas del periodo.");
    if (from > to) return setError("La fecha inicial no puede ser posterior a la final.");
    if (daysBetween(from, to) + 1 > MAX_REPORT_DAYS) return setError(`El periodo puede tener máximo ${MAX_REPORT_DAYS} días.`);
    go({ from, to });
  }

  return (
    <div className="flex flex-col gap-3">
      <ToggleButtonGroup
        aria-label="Periodo"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[custom ? CUSTOM : (preset?.key ?? CUSTOM)]}
        isDisabled={pending}
        onSelectionChange={(keys) => {
          const k = [...keys][0];
          if (k === undefined) return;
          if (k === CUSTOM) return setCustom(true);
          const p = period.presets.find((x) => x.key === k);
          if (!p) return;
          setCustom(false);
          go(p);
        }}
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]"
      >
        {[...period.presets.map((p) => ({ id: p.key, label: p.label })), { id: CUSTOM, label: "Personalizado" }].map((p) => (
          <ToggleButton
            key={p.id}
            id={p.id}
            className={({ isSelected, isFocusVisible }) =>
              cx(
                "h-10 shrink-0 whitespace-nowrap rounded-full border px-3.5 text-sm font-semibold transition-colors",
                isSelected ? "border-cuero bg-cuero text-hueso" : "border-tinta/20 bg-papel text-tinta/80",
                isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
              )
            }
          >
            {p.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {custom ? (
        <Form onSubmit={applyCustom} validationBehavior="aria" className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <DateField label="Desde" value={from} onChange={setFrom} max={to || undefined} isRequired />
          <DateField label="Hasta" value={to} onChange={setTo} min={from || undefined} isRequired />
          <Btn type="submit" className="col-span-2 h-12 sm:col-span-1" isPending={pending}>
            <CalendarRange size={18} aria-hidden /> Ver
          </Btn>
        </Form>
      ) : null}

      <p className="text-sm text-tinta/80" aria-live="polite">
        {pending ? "Cargando…" : <span className="monto font-semibold">{period.from === period.to ? dayLabel(period.from) : `${dayLabel(period.from)} al ${dayLabel(period.to)}`}</span>}
      </p>
      <FormError message={error} />
    </div>
  );
}

/** Descarga el CSV (abre en Excel) de un historial del periodo. */
export function ExportCsvButton({ report, from, to, label }: { report: "sales" | "cash_sessions"; from: string; to: string; label: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    const r = await callAction(() => exportReportCsvAction({ report, from, to }));
    setBusy(false);
    if (!r.ok) return toast(r.error, "error");
    const href = URL.createObjectURL(new Blob([r.data.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = href;
    a.download = r.data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    toast(`Descargado: ${r.data.filename}`);
  }

  return (
    <Btn variant="secondary" onPress={() => void download()} isPending={busy}>
      <Download size={18} aria-hidden /> {busy ? "Preparando…" : label}
    </Btn>
  );
}
