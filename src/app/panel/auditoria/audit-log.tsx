"use client";

import { ArrowRight, Filter, ScrollText, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Form } from "react-aria-components";
import { DateField } from "../_components/date-field";
import { momentLabel } from "../_components/dates";
import { callAction } from "../_components/money-field";
import { SelectField } from "../_components/select-field";
import { Btn, cx, PageHeader } from "../_components/ui";
import { card, Chip, FormError } from "../_manage/controls";
import { loadAuditLog } from "./actions";

// Visor de la bitácora: quién hizo qué y cuándo (hora de la sede), con los cambios "antes → después"
// de la configuración. Los valores ya vienen formateados del servidor.

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
type Log = OkData<Awaited<ReturnType<typeof loadAuditLog>>>;
type Filters = NonNullable<Parameters<typeof loadAuditLog>[0]>;
type Category = NonNullable<Filters["category"]>;

const ALL = "all";
const CATEGORIES: { id: Category | typeof ALL; label: string }[] = [
  { id: ALL, label: "Todas" },
  { id: "finanzas", label: "Finanzas" },
  { id: "configuracion", label: "Configuración" },
  { id: "personal", label: "Personal" },
  { id: "informes", label: "Informes" },
];

export function AuditLog({ initial }: { initial: Log }) {
  const [events, setEvents] = useState(initial.events);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [category, setCategory] = useState<Category | typeof ALL>(ALL);
  /** Filtros con los que se cargó la lista (para "Cargar más"). */
  const [applied, setApplied] = useState<Filters>({});
  const [loading, setLoading] = useState<"filter" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  async function fetchPage(filters: Filters, mode: "filter" | "more") {
    setError(null);
    setLoading(mode);
    const r = await callAction(() => loadAuditLog(filters));
    setLoading(null);
    if (!r.ok) return setError(r.error);
    setEvents((prev) => (mode === "more" ? [...prev, ...r.data.events] : r.data.events));
    setCursor(r.data.nextCursor);
  }

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (from && to && from > to) return setError("La fecha inicial no puede ser posterior a la final.");
    const filters: Filters = {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(category !== ALL ? { category } : {}),
    };
    setApplied(filters);
    void fetchPage(filters, "filter");
  }

  function clear() {
    setFrom("");
    setTo("");
    setCategory(ALL);
    setApplied({});
    void fetchPage({}, "filter");
  }

  const filtered = Object.keys(applied).length > 0;

  return (
    <>
      <PageHeader
        eyebrow="Quién hizo qué"
        title="Auditoría"
        actions={
          <Btn variant="secondary" onPress={() => setShowFilters((v) => !v)} aria-expanded={showFilters} aria-controls="filtros">
            <Filter size={18} aria-hidden /> Filtros{filtered ? " (activos)" : ""}
          </Btn>
        }
      />
      <p className="-mt-3 text-sm text-tinta/70">
        Acciones de dinero, configuración y personal desde el sprint 5. Lo anterior sigue en Caja, Anulaciones y la agenda.
      </p>

      {showFilters ? (
        <Form id="filtros" onSubmit={apply} validationBehavior="aria" className={cx(card, "grid grid-cols-2 gap-3 p-4")}>
          <DateField label="Desde" value={from} onChange={setFrom} max={to || undefined} />
          <DateField label="Hasta" value={to} onChange={setTo} min={from || undefined} />
          <SelectField
            className="col-span-2"
            label="Categoría"
            options={CATEGORIES.map((c) => ({ id: c.id, label: c.label }))}
            value={category}
            onChange={(id) => setCategory(id as Category | typeof ALL)}
          />
          <div className="col-span-2 flex flex-col-reverse gap-2 min-[400px]:flex-row min-[400px]:justify-end">
            {filtered ? (
              <Btn variant="ghost" onPress={clear} isDisabled={loading !== null}>
                <X size={16} aria-hidden /> Quitar filtros
              </Btn>
            ) : null}
            <Btn type="submit" isPending={loading === "filter"}>
              Ver
            </Btn>
          </div>
        </Form>
      ) : null}

      <FormError message={error} />

      <div aria-busy={loading !== null} aria-live="polite" className="sr-only">
        {loading === "filter" ? "Cargando la bitácora…" : loading === "more" ? "Cargando más eventos…" : `${events.length} eventos`}
      </div>

      {events.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-tinta/20 bg-papel px-6 py-12 text-center">
          <ScrollText size={32} className="text-tinta/40" aria-hidden />
          <p className="mt-3 font-display text-2xl">Sin eventos</p>
          <p className="mt-1 text-sm text-tinta/70">{filtered ? "Nada con esos filtros." : "Todavía no hay acciones registradas."}</p>
        </div>
      ) : (
        <ol className={cx(card, "divide-y divide-tinta/10", loading === "filter" && "opacity-60")}>
          {events.map((ev) => (
            <li key={ev.id} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold">{ev.actionLabel}</span>
                <Chip tone="neutral">{ev.categoryLabel}</Chip>
              </div>
              <p className="text-sm text-tinta/80">{ev.summary}</p>
              <p className="text-xs text-tinta/70">
                <span className="monto">{momentLabel(ev.atLabel)}</span> · {ev.actorName}
              </p>
              {ev.changes.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-1 rounded-lg bg-hueso/60 px-3 py-2 text-xs" aria-label="Cambios">
                  {ev.changes.map((c, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="font-semibold">{c.field}:</span>
                      <span className="monto text-tinta/70 line-through decoration-tinta/40">{c.before}</span>
                      <ArrowRight size={12} aria-label="cambió a" className="text-tinta/60" />
                      <span className="monto font-semibold">{c.after}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {cursor ? (
        <Btn variant="secondary" className="self-center" isPending={loading === "more"} onPress={() => void fetchPage({ ...applied, before: cursor }, "more")}>
          {loading === "more" ? "Cargando…" : "Cargar más"}
        </Btn>
      ) : events.length > 0 ? (
        <p className="text-center text-xs text-tinta/70">No hay más eventos.</p>
      ) : null}
    </>
  );
}
