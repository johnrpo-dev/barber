"use client";

import { CalendarOff, Clock } from "lucide-react";
import { type FormEvent, useId, useState, useTransition } from "react";
import { Form, Input, Label, Radio, RadioGroup, TextField } from "react-aria-components";
import type { ActionResult } from "@/lib/action";
import { Btn, cx, field, useToast } from "../_components/ui";
import { card, Chip, FormError, RadioDot, radioCard } from "../_manage/controls";
import { cancelTimeOffAction } from "../bloqueos/actions";
import type { TimeOffView } from "./time-off-view";

// Ausencias, bloqueos y cierres: lista con "Anular" y formulario para agregar.
// Las fechas viajan como "yyyy-MM-dd" y las horas como "HH:MM" en hora local de la sede;
// el servidor las convierte con la zona de la sede.

export const KIND_LABELS = { absence: "Ausencia", block: "Bloqueo" } as const;

export type TimeOffPayload =
  | { allDay: true; fromDate: string; toDate: string }
  | { allDay: false; date: string; startTime: string; endTime: string };

// ─── Lista ───────────────────────────────────────────────────────────────────

export function TimeOffList({
  items,
  staffId,
  emptyText,
  showKind = true,
}: {
  items: TimeOffView[];
  staffId?: string;
  emptyText: string;
  showKind?: boolean;
}) {
  if (items.length === 0) {
    return <p className={cx(card, "px-4 py-6 text-center text-sm text-tinta/70")}>{emptyText}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <TimeOffItem key={item.id} item={item} staffId={staffId} showKind={showKind} />
      ))}
    </ul>
  );
}

function TimeOffItem({ item, staffId, showKind }: { item: TimeOffView; staffId?: string; showKind: boolean }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  function cancel() {
    startTransition(async () => {
      const res = await cancelTimeOffAction({ timeOffId: item.id, staffId });
      if (res.ok) toast("Anulada. El tiempo vuelve a estar disponible en la agenda.");
      else toast(res.error, "error");
      setConfirming(false);
    });
  }

  return (
    <li className={cx(card, "flex flex-wrap items-center justify-between gap-3 px-4 py-3")}>
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-tinta/5 text-tinta/70">
          {item.allDay ? <CalendarOff size={18} strokeWidth={1.75} /> : <Clock size={18} strokeWidth={1.75} />}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-semibold first-letter:uppercase">{item.dateLabel}</p>
          <p className="text-sm text-tinta/70">
            <span className="monto">{item.timeLabel}</span>
            {item.reason ? ` · ${item.reason}` : null}
          </p>
          {showKind ? (
            <span className="mt-1">
              <Chip tone={item.kind === "absence" ? "primary" : "neutral"}>{KIND_LABELS[item.kind]}</Chip>
            </span>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2" role="group" aria-label="Confirmar anulación">
          <Btn variant="ghost" onPress={() => setConfirming(false)} isDisabled={pending}>
            No
          </Btn>
          <Btn variant="danger" onPress={cancel} isPending={pending} autoFocus>
            Sí, anular
          </Btn>
        </div>
      ) : (
        <Btn variant="secondary" onPress={() => setConfirming(true)}>
          Anular
        </Btn>
      )}
    </li>
  );
}

// ─── Formulario ──────────────────────────────────────────────────────────────

function DateInput({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: string;
}) {
  const id = useId();
  return (
    <div className={field.root}>
      <label htmlFor={id} className={field.label}>
        {label}
      </label>
      <input id={id} type="date" required value={value} min={min} onChange={(e) => onChange(e.target.value)} className={field.input} />
    </div>
  );
}

function TimeInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className={field.root}>
      <label htmlFor={id} className={field.label}>
        {label}
      </label>
      <input
        id={id}
        type="time"
        step={300}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(field.input, "monto")}
      />
    </div>
  );
}

/**
 * Formulario de ausencia/bloqueo (variant "staff"), de bloqueo propio del barbero (variant "own":
 * sin ausencias) o de cierre de la sede (variant "closure": solo días completos).
 * Tras guardar avisa si quedaron citas dentro del rango.
 */
export function TimeOffForm({
  variant,
  today,
  subject,
  submit,
  onDone,
}: {
  variant: "staff" | "own" | "closure";
  today: string;
  /** Quién queda afectado, para el aviso de citas: "Andrés" o "La sede". */
  subject: string;
  submit: (values: {
    kind: "absence" | "block";
    reason: string;
    range: TimeOffPayload;
  }) => Promise<ActionResult<{ overlappingAppointments: number }>>;
  onDone?: () => void;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [allDay, setAllDay] = useState(true);
  const [kind, setKind] = useState<"absence" | "block">(variant === "own" ? "block" : "absence");
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [date, setDate] = useState(today);
  const [startTime, setStartTime] = useState("12:00");
  const [endTime, setEndTime] = useState("14:00");
  const [reason, setReason] = useState("");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const isAllDay = variant === "closure" || allDay;
    if (isAllDay && toDate < fromDate) return setError("La fecha final debe ser igual o posterior a la inicial.");
    if (!isAllDay && endTime <= startTime) return setError("La hora final debe ser después de la inicial.");
    const range: TimeOffPayload = isAllDay ? { allDay: true, fromDate, toDate } : { allDay: false, date, startTime, endTime };

    startTransition(async () => {
      const res = await submit({ kind, reason, range });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const n = res.data.overlappingAppointments;
      if (n > 0) {
        // Aviso persistente: hay citas que alguien debe mover o cancelar.
        toast(`${subject} tiene ${n} ${n === 1 ? "cita" : "citas"} en ese rango; revísalas en la agenda`, "error");
      } else {
        toast(variant === "closure" ? "Cierre registrado" : kind === "block" ? "Bloqueo registrado" : "Ausencia registrada");
      }
      setReason("");
      onDone?.();
    });
  }

  return (
    <Form onSubmit={onSubmit} className="flex flex-col gap-5" validationBehavior="aria">
      {variant === "staff" ? (
        <RadioGroup
          value={kind}
          onChange={(v) => setKind(v === "block" ? "block" : "absence")}
          orientation="horizontal"
          className={field.root}
        >
          <Label className={field.label}>Tipo</Label>
          <div className="grid grid-cols-2 gap-2">
            <Radio value="absence" className={cx(radioCard, "group")}>
              <RadioDot />
              <span className="flex flex-col">
                Ausencia
                <span className="text-xs font-normal text-tinta/70">Vacaciones, incapacidad</span>
              </span>
            </Radio>
            <Radio value="block" className={cx(radioCard, "group")}>
              <RadioDot />
              <span className="flex flex-col">
                Bloqueo
                <span className="text-xs font-normal text-tinta/70">Diligencia, almuerzo largo</span>
              </span>
            </Radio>
          </div>
        </RadioGroup>
      ) : null}

      {variant !== "closure" ? (
        <RadioGroup
          value={allDay ? "all" : "hours"}
          onChange={(v) => setAllDay(v === "all")}
          orientation="horizontal"
          className={field.root}
        >
          <Label className={field.label}>Duración</Label>
          <div className="grid grid-cols-2 gap-2">
            <Radio value="all" className={cx(radioCard, "group")}>
              <RadioDot />
              Días completos
            </Radio>
            <Radio value="hours" className={cx(radioCard, "group")}>
              <RadioDot />
              Unas horas
            </Radio>
          </div>
        </RadioGroup>
      ) : null}

      {variant === "closure" || allDay ? (
        <div className="grid grid-cols-1 gap-4 min-[400px]:grid-cols-2">
          <DateInput
            label="Desde"
            value={fromDate}
            min={today}
            onChange={(v) => {
              setFromDate(v);
              if (toDate < v) setToDate(v);
            }}
          />
          <DateInput label="Hasta (incluido)" value={toDate} min={fromDate || today} onChange={setToDate} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <DateInput label="Fecha" value={date} min={today} onChange={setDate} />
          </div>
          <TimeInput label="Desde" value={startTime} onChange={setStartTime} />
          <TimeInput label="Hasta" value={endTime} onChange={setEndTime} />
        </div>
      )}

      <TextField value={reason} onChange={setReason} maxLength={200} className={field.root}>
        <Label className={field.label}>{variant === "closure" ? "Motivo" : "Motivo (opcional)"}</Label>
        <Input className={field.input} placeholder={variant === "closure" ? "Festivo, remodelación…" : "Cita médica, vacaciones…"} />
      </TextField>

      <FormError message={error} />

      <div className="flex justify-end">
        <Btn type="submit" isPending={pending} className="w-full min-[400px]:w-auto">
          {pending ? "Guardando…" : variant === "closure" ? "Cerrar la sede esos días" : "Agregar"}
        </Btn>
      </div>
    </Form>
  );
}
