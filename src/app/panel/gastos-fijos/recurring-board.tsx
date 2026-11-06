"use client";

import { CalendarClock, Landmark, Pencil, Plus, Receipt, SkipForward, TriangleAlert, Wallet } from "lucide-react";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { Form, Input, Label, Radio, RadioGroup, TextArea, TextField } from "react-aria-components";
import { card, Chip, FieldMessage, FormError, MinutesField, RadioDot, radioCard, Toggle, useFieldErrors } from "../_manage/controls";
import { callAction, MoneyField, unitsOf } from "../_components/money-field";
import { SelectField } from "../_components/select-field";
import { Btn, cx, field, PageHeader, Sheet, useToast } from "../_components/ui";
import { loadRecurringExpenses, type RecurringTemplateView, type RecurringView, saveRecurringExpenseAction, skipRecurringExpenseAction } from "./actions";
import { DueSummary, FormActions, INACTIVE_CATEGORY_REASON, RecurringRegisterForm } from "./register-form";
import type { RecurringDueItem } from "./view";

// Gastos fijos (docs/sprint-8-gastos-controles.md §5): lo que toca pagar arriba (vencido, vence hoy o
// en los próximos 3 días) y las plantillas abajo. Nada se registra solo: "Registrar" abre el
// formulario de gasto prellenado; "Omitir" (solo el dueño) pide el motivo.

type SheetState = { kind: "edit"; template: RecurringTemplateView | null } | { kind: "register"; item: RecurringDueItem } | { kind: "skip"; item: RecurringDueItem } | null;

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;
const pad = (n: number) => String(n).padStart(2, "0");
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const monthStart = (i: number) => `${Math.floor(i / 12)}-${pad((i % 12) + 1)}-01`;
const monthLabel = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]} de ${period.slice(0, 4)}`;

function StatusBadge({ item }: { item: RecurringDueItem }) {
  if (item.status === "overdue") {
    return (
      <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-alerta/30 bg-alerta/5 px-2.5 text-xs font-semibold text-alerta">
        <TriangleAlert size={14} aria-hidden /> {item.statusLabel}
      </span>
    );
  }
  return (
    <Chip tone="primary" icon={<CalendarClock size={14} aria-hidden />}>
      {item.statusLabel}
    </Chip>
  );
}

export function RecurringBoard({ initial }: { initial: RecurringView }) {
  const toast = useToast();
  const [view, setView] = useState(initial);
  const [sheet, setSheet] = useState<SheetState>(null);

  const refresh = useCallback(async () => {
    const r = await callAction(() => loadRecurringExpenses());
    if (r.ok) setView(r.data);
    else toast(r.error, "error");
  }, [toast]);

  const done = useCallback(
    (message: string) => {
      setSheet(null);
      toast(message);
      void refresh();
    },
    [refresh, toast],
  );
  const close = () => setSheet(null);

  const due = useMemo(() => view.templates.flatMap((t) => t.due).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name)), [view.templates]);

  const registerBlocked = (item: RecurringDueItem): string | null => {
    if (!item.categoryActive) return INACTIVE_CATEGORY_REASON;
    if (item.payMode === "bank") return view.canRegisterBank ? null : "Solo el dueño registra gastos del banco";
    if (!view.canRegisterCash) return "No puedes registrar gastos de caja";
    return view.cashOpen ? null : "Abre la caja de hoy para registrarlo";
  };

  return (
    <>
      <PageHeader
        title="Gastos fijos"
        actions={
          <Btn onPress={() => setSheet({ kind: "edit", template: null })}>
            <Plus size={18} aria-hidden /> Nuevo
          </Btn>
        }
      />
      <p className="-mt-3 text-sm text-tinta/80">
        Nada se registra solo. Cuando un gasto fijo vence, regístralo con lo que de verdad se pagó, u omítelo diciendo por qué.
      </p>

      <section aria-labelledby="por-pagar" className="flex flex-col gap-3">
        <h2 id="por-pagar" className="font-display text-2xl leading-tight">
          Por pagar
        </h2>
        {due.length === 0 ? (
          <p className={cx(card, "p-4 text-sm text-tinta/70")}>Nada vencido ni por vencer en los próximos 3 días.</p>
        ) : (
          <ul className={cx(card, "divide-y divide-tinta/10")} role="list">
            {due.map((item) => {
              const blocked = registerBlocked(item);
              return (
                <li key={`${item.recurringId}-${item.period}`} className="flex flex-col gap-3 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{item.name}</p>
                      <p className="text-xs text-tinta/70">
                        {item.periodLabel} · vence el {item.dueLabel} · {item.payMode === "cash" ? "de la caja" : "del banco"}
                      </p>
                    </div>
                    <StatusBadge item={item} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="monto text-sm text-tinta/80">Estimado {item.estimatedLabel}</span>
                    <div className="flex gap-2 max-[399px]:w-full max-[399px]:justify-end">
                      {view.canSkip ? (
                        <Btn variant="secondary" size="sm" className="h-11" onPress={() => setSheet({ kind: "skip", item })}>
                          <SkipForward size={16} aria-hidden /> Omitir<span className="sr-only"> {item.name} de {item.periodLabel}</span>
                        </Btn>
                      ) : null}
                      <Btn size="sm" className="h-11" onPress={() => setSheet({ kind: "register", item })} isDisabled={!!blocked}>
                        <Receipt size={16} aria-hidden /> Registrar<span className="sr-only"> {item.name} de {item.periodLabel}</span>
                      </Btn>
                    </div>
                  </div>
                  {blocked ? <p className="text-xs text-tinta/70">{blocked}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="plantillas" className="flex flex-col gap-3">
        <h2 id="plantillas" className="font-display text-2xl leading-tight">
          Plantillas
        </h2>
        {view.templates.length === 0 ? (
          <p className={cx(card, "p-4 text-sm text-tinta/70")}>
            Aún no hay gastos fijos. Crea el arriendo, los servicios o el internet para que el sistema recuerde cuándo pagarlos.
          </p>
        ) : (
          <ul className={cx(card, "divide-y divide-tinta/10")} role="list">
            {view.templates.map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{t.name}</p>
                    <Chip tone="neutral" icon={t.payMode === "cash" ? <Wallet size={14} aria-hidden /> : <Landmark size={14} aria-hidden />}>
                      {t.payMode === "cash" ? "Caja" : "Banco"}
                    </Chip>
                    {!t.active ? <Chip tone="muted">Pausado</Chip> : null}
                  </div>
                  <p className="text-xs text-tinta/70">
                    {t.scheduleLabel} · {t.categoryName} · <span className="monto">{t.estimatedLabel}</span>
                  </p>
                  {t.nextDueLabel || t.lastRunLabel ? (
                    <p className="text-xs text-tinta/70">{[t.nextDueLabel, t.lastRunLabel ? `Último: ${t.lastRunLabel}` : null].filter(Boolean).join(" · ")}</p>
                  ) : null}
                </div>
                <Btn variant="secondary" size="sm" className="h-11 shrink-0" onPress={() => setSheet({ kind: "edit", template: t })}>
                  <Pencil size={16} aria-hidden /> Editar<span className="sr-only"> {t.name}</span>
                </Btn>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Sheet isOpen={sheet?.kind === "edit"} onOpenChange={(o) => !o && close()} title={sheet?.kind === "edit" && sheet.template ? "Editar gasto fijo" : "Nuevo gasto fijo"}>
        {sheet?.kind === "edit" ? <TemplateForm view={view} template={sheet.template} onDone={done} onCancel={close} /> : null}
      </Sheet>
      <Sheet isOpen={sheet?.kind === "register"} onOpenChange={(o) => !o && close()} title="Registrar gasto fijo" description="Queda como un gasto normal, con su asiento.">
        {sheet?.kind === "register" ? <RecurringRegisterForm item={sheet.item} cashOk={view.cashOpen} onDone={done} onCancel={close} /> : null}
      </Sheet>
      <Sheet isOpen={sheet?.kind === "skip"} onOpenChange={(o) => !o && close()} title="Omitir este periodo" description="No se registra ningún gasto. Queda el motivo con tu nombre.">
        {sheet?.kind === "skip" ? <SkipForm item={sheet.item} onDone={done} onCancel={close} /> : null}
      </Sheet>
    </>
  );
}

// ─── Plantilla ───────────────────────────────────────────────────────────────

const INTERVALS = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), label: i === 0 ? "Cada mes" : `Cada ${i + 1} meses` }));

function TemplateForm({
  view,
  template,
  onDone,
  onCancel,
}: {
  view: RecurringView;
  template: RecurringTemplateView | null;
  onDone: (m: string) => void;
  onCancel: () => void;
}) {
  const invalid = useFieldErrors<"name" | "category" | "amount" | "startMonth">();
  const [name, setName] = useState(template?.name ?? "");
  const [categoryId, setCategoryId] = useState<string | null>(template?.categoryId ?? null);
  const [amount, setAmount] = useState(template?.estimatedUnits ?? "");
  const [payMode, setPayMode] = useState<"cash" | "bank">(template?.payMode ?? "bank");
  const [dayOfMonth, setDayOfMonth] = useState(template?.dayOfMonth ?? 5);
  const [interval, setIntervalMonths] = useState(String(template?.intervalMonths ?? 1));
  const thisMonth = `${view.today.slice(0, 7)}-01`;
  const [startMonth, setStartMonth] = useState<string | null>(template?.startMonth ?? thisMonth);
  const [active, setActive] = useState(template?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // De 12 meses atrás a 12 adelante (lo que acepta el servidor); al editar, también el que ya tenía.
  const months = useMemo(() => {
    const base = monthIndex(thisMonth);
    const list = Array.from({ length: 25 }, (_, i) => monthStart(base - 12 + i));
    if (template && !list.includes(template.startMonth)) list.unshift(template.startMonth);
    return list.map((m) => ({ id: m, label: monthLabel(m) }));
  }, [thisMonth, template]);

  // La categoría que ya tenía, aunque esté desactivada, sigue en la lista.
  const categories = useMemo(() => {
    const list = view.categories.map((c) => ({ id: c.id, label: c.name }));
    if (template && !list.some((c) => c.id === template.categoryId)) list.push({ id: template.categoryId, label: `${template.categoryName} (desactivada)` });
    return list;
  }, [view.categories, template]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const clean = name.replace(/\s+/g, " ").trim();
    if (
      !invalid.check(form, {
        ...(clean.length < 3 ? { name: "Escribe el nombre (al menos 3 letras)." } : {}),
        ...(!categoryId ? { category: "Elige la categoría." } : {}),
        ...(unitsOf(amount) === 0n ? { amount: "Escribe el monto estimado." } : {}),
        ...(!startMonth ? { startMonth: "Elige el mes de inicio." } : {}),
      })
    )
      return;
    setPending(true);
    const r = await callAction(() =>
      saveRecurringExpenseAction({
        id: template?.id,
        name: clean,
        categoryId: categoryId!,
        estimatedUnits: amount,
        payMode,
        dayOfMonth,
        intervalMonths: Number(interval),
        startMonth: startMonth!,
        active,
      }),
    );
    setPending(false);
    if (r.ok) return onDone(template ? "Gasto fijo guardado" : "Gasto fijo creado");
    setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <TextField
        name="name"
        value={name}
        onChange={(v) => (setName(v), invalid.clear("name"))}
        isRequired
        isInvalid={!!invalid.errors.name}
        maxLength={60}
        className={field.root}
      >
        <Label className={field.label}>Nombre</Label>
        <Input className={field.input} placeholder="Arriendo del local" autoComplete="off" />
        <FieldMessage>{invalid.errors.name}</FieldMessage>
      </TextField>
      <SelectField
        name="category"
        label="Categoría"
        options={categories}
        value={categoryId}
        onChange={(v) => (setCategoryId(v), invalid.clear("category"))}
        error={invalid.errors.category}
        isRequired
      />
      <MoneyField
        name="amount"
        label="Monto estimado"
        value={amount}
        onChange={(v) => (setAmount(v), invalid.clear("amount"))}
        error={invalid.errors.amount}
        description="Al registrar cada mes se puede cambiar (los servicios varían)."
        isRequired
      />
      <RadioGroup value={payMode} onChange={(v) => setPayMode(v as "cash" | "bank")} className={field.root}>
        <Label className={field.label}>Sale de</Label>
        <div className="grid grid-cols-2 gap-2">
          <Radio value="cash" className={cx(radioCard, "group")}>
            <RadioDot />
            <span className="inline-flex items-center gap-1.5">
              <Wallet size={16} aria-hidden /> Caja
            </span>
          </Radio>
          <Radio value="bank" className={cx(radioCard, "group")}>
            <RadioDot />
            <span className="inline-flex items-center gap-1.5">
              <Landmark size={16} aria-hidden /> Banco
            </span>
          </Radio>
        </div>
      </RadioGroup>
      <div className="grid grid-cols-1 gap-4 min-[400px]:grid-cols-2">
        <MinutesField label="Día de pago" value={dayOfMonth} onChange={setDayOfMonth} minValue={1} maxValue={28} step={1} description="Del 1 al 28." />
        <SelectField label="Se paga" options={INTERVALS} value={interval} onChange={setIntervalMonths} isRequired />
      </div>
      <SelectField
        name="startMonth"
        label="Desde"
        options={months}
        value={startMonth}
        onChange={(v) => (setStartMonth(v), invalid.clear("startMonth"))}
        error={invalid.errors.startMonth}
        description="El primer mes que se paga."
        isRequired
      />
      <Toggle isSelected={active} onChange={setActive}>
        {active ? "Activo: avisa cuando vence" : "Pausado: no avisa"}
      </Toggle>
      <FormError message={error} />
      <FormActions pending={pending} onCancel={onCancel}>
        {template ? "Guardar" : "Crear gasto fijo"}
      </FormActions>
    </Form>
  );
}

// ─── Omitir ──────────────────────────────────────────────────────────────────

function SkipForm({ item, onDone, onCancel }: { item: RecurringDueItem; onDone: (m: string) => void; onCancel: () => void }) {
  const invalid = useFieldErrors<"reason">();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const clean = reason.replace(/\s+/g, " ").trim();
    if (!invalid.check(e.currentTarget, clean.length < 3 ? { reason: "Explica por qué se omite (al menos 3 letras)." } : {})) return;
    setPending(true);
    // Sin clave en el navegador: un periodo se omite una sola vez y repetir con el mismo motivo no duplica.
    const r = await callAction(() => skipRecurringExpenseAction({ recurringId: item.recurringId, period: item.period, reason: clean }));
    setPending(false);
    if (r.ok) return onDone("Periodo omitido");
    setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <DueSummary item={item} />
      <TextField
        name="reason"
        value={reason}
        onChange={(v) => (setReason(v), invalid.clear("reason"))}
        isRequired
        isInvalid={!!invalid.errors.reason}
        maxLength={300}
        className={field.root}
      >
        <Label className={field.label}>Motivo</Label>
        <TextArea className={cx(field.input, "h-20 py-2")} placeholder="Se pagó junto con el mes anterior" />
        <FieldMessage>{invalid.errors.reason}</FieldMessage>
      </TextField>
      <FormError message={error} />
      <FormActions pending={pending} onCancel={onCancel}>
        <SkipForward size={18} aria-hidden /> Omitir periodo
      </FormActions>
    </Form>
  );
}
