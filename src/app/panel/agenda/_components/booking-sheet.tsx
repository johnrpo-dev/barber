"use client";

import { Check, ChevronLeft, Clock, Scissors, UserRound, Users, Zap } from "lucide-react";
import { useState, useTransition } from "react";
import { Input, Label, Radio, RadioGroup, TextArea, TextField } from "react-aria-components";
import { parseTime, formatTime } from "@/domain/staff/schedule";
import { Btn, cx, field, Sheet, useToast } from "../../_components/ui";
import { bookAppointment, startWalkIn } from "../actions";
import type { AgendaColumnView, ServiceOption } from "../data";
import { type ClientChoice, ClientPicker, clientIsReady, toActionClient } from "./client-picker";
import { longDate, relativeDate, SlotPicker } from "./slot-picker";

// Nueva cita en cuatro pasos (servicio → barbero → hora → cliente) y walk-in en una sola
// pantalla. Cada apertura lleva su propia clave de idempotencia: un doble toque no duplica.

export type BookingMode = "appointment" | "walk_in";
export interface BookingPrefill {
  staffId?: string;
  minute?: number;
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function BookingSheet({
  mode,
  isOpen,
  onOpenChange,
  services,
  columns,
  date,
  today,
  prefill,
}: {
  mode: BookingMode;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  services: ServiceOption[];
  columns: AgendaColumnView[];
  date: string;
  today: string;
  prefill?: BookingPrefill;
}) {
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      wide={mode === "appointment"}
      title={mode === "appointment" ? "Nueva cita" : "Walk-in"}
      description={mode === "walk_in" ? "Llega sin cita: empieza ahora con el barbero libre." : undefined}
    >
      {/* Se monta de nuevo en cada apertura: estado y clave limpios. */}
      {isOpen ? (
        mode === "appointment" ? (
          <AppointmentFlow
            services={services}
            columns={columns}
            date={date < today ? today : date}
            today={today}
            prefill={prefill}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <WalkInForm services={services} columns={columns} onDone={() => onOpenChange(false)} />
        )
      ) : null}
    </Sheet>
  );
}

// ─── Piezas ──────────────────────────────────────────────────────────────────

function ServiceChoice({
  services,
  value,
  onChange,
  compact = false,
}: {
  services: ServiceOption[];
  value: string | null;
  onChange: (id: string) => void;
  compact?: boolean;
}) {
  if (services.length === 0) {
    return <p className="rounded-xl border border-dashed border-tinta/20 p-4 text-sm text-tinta/70">No hay servicios activos. El dueño los crea en Servicios.</p>;
  }
  return (
    <RadioGroup aria-label="Servicio" value={value} onChange={onChange} className={cx("grid gap-2", compact ? "grid-cols-2" : "sm:grid-cols-2")}>
      {services.map((s) => (
        <Radio
          key={s.id}
          value={s.id}
          className={({ isSelected, isFocusVisible }) =>
            cx(
              "flex cursor-pointer flex-col gap-1 rounded-xl border p-3 transition-colors",
              isSelected ? "border-cuero bg-cuero/8 ring-1 ring-cuero" : "border-tinta/15 bg-papel hover:border-tinta/35",
              isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
            )
          }
        >
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
                <span className="monto font-semibold text-tinta">{s.price}</span>
              </span>
            </>
          )}
        </Radio>
      ))}
    </RadioGroup>
  );
}

function StaffChoice({
  columns,
  value,
  onChange,
}: {
  columns: AgendaColumnView[];
  value: string;
  onChange: (id: string) => void;
}) {
  const options = [{ id: "any", name: "Cualquiera", hint: "El que esté libre" }, ...columns.map((c) => ({ id: c.staffId, name: c.displayName, hint: "" }))];
  return (
    <RadioGroup aria-label="Barbero" value={value} onChange={onChange} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {options.map((o) => (
        <Radio
          key={o.id}
          value={o.id}
          className={({ isSelected, isFocusVisible }) =>
            cx(
              "flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors",
              isSelected ? "border-cuero bg-cuero/8 ring-1 ring-cuero" : "border-tinta/15 bg-papel hover:border-tinta/35",
              isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
            )
          }
        >
          <span
            className={cx(
              "grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold",
              o.id === "any" ? "bg-tinta/8 text-tinta" : "bg-botella text-hueso",
            )}
            aria-hidden
          >
            {o.id === "any" ? <Users size={18} /> : initials(o.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold">{o.name}</span>
            {o.hint ? <span className="block text-xs text-tinta/70">{o.hint}</span> : null}
          </span>
        </Radio>
      ))}
    </RadioGroup>
  );
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// ─── Nueva cita ──────────────────────────────────────────────────────────────

const STEPS = ["Servicio", "Barbero", "Hora", "Cliente"] as const;

function AppointmentFlow({
  services,
  columns,
  date: initialDate,
  today,
  prefill,
  onDone,
}: {
  services: ServiceOption[];
  columns: AgendaColumnView[];
  date: string;
  today: string;
  prefill?: BookingPrefill;
  onDone: () => void;
}) {
  const toast = useToast();
  const [key] = useState(newKey);
  const [step, setStep] = useState(0);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string>(prefill?.staffId ?? "any");
  const [date, setDate] = useState(initialDate);
  const [minute, setMinute] = useState<number | null>(null);
  const [outside, setOutside] = useState(false);
  const [outsideTime, setOutsideTime] = useState("");
  const [client, setClient] = useState<ClientChoice>({ kind: "none", name: "" });
  const [notes, setNotes] = useState("");
  // La hora tocada en la grilla se propone una sola vez; al volver atrás ya no se reimpone.
  const [suggestedMinute, setSuggestedMinute] = useState(prefill?.minute);
  const [pending, startTransition] = useTransition();

  const service = services.find((s) => s.id === serviceId);
  const staffName = staffId === "any" ? "Cualquiera" : (columns.find((c) => c.staffId === staffId)?.displayName ?? "");

  function submit() {
    if (!serviceId || minute === null) return;
    startTransition(async () => {
      const r = await bookAppointment({
        serviceId,
        staffId,
        date,
        minute,
        client: toActionClient(client),
        notes: notes.trim() || undefined,
        allowOutsideHours: outside || undefined,
        idempotencyKey: key,
      });
      if (r.ok) {
        const who = columns.find((c) => c.staffId === r.data.staffId)?.displayName;
        toast(`Cita agendada: ${relativeDate(date, today).toLowerCase()} a las ${r.data.label}${who ? ` con ${who}` : ""}`);
        onDone();
      } else {
        toast(r.error, "error");
        if (/horario|libre|turno/i.test(r.error)) setStep(2);
      }
    });
  }

  const summary = [
    service ? { icon: Scissors, text: service.name, step: 0 } : null,
    step > 1 ? { icon: UserRound, text: staffName, step: 1 } : null,
    step > 2 && minute !== null ? { icon: Clock, text: `${relativeDate(date, today)} · ${formatTime(minute)}${outside ? " (fuera de turno)" : ""}`, step: 2 } : null,
  ].filter((x) => x !== null);

  return (
    <div className="flex flex-col gap-5">
      {/* Progreso */}
      <div className="flex flex-col gap-2">
        <ol className="grid grid-cols-4 gap-1.5" aria-label="Pasos">
          {STEPS.map((label, i) => (
            <li key={label} className="flex flex-col gap-1" aria-current={i === step ? "step" : undefined}>
              <span className={cx("h-1 rounded-full transition-colors", i <= step ? "bg-cuero" : "bg-tinta/10")} aria-hidden />
              <span className={cx("text-[11px] font-semibold", i === step ? "text-tinta" : "text-tinta/70")}>{label}</span>
            </li>
          ))}
        </ol>
        {summary.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {summary.map((s) => (
              <button
                key={s.step}
                type="button"
                onClick={() => setStep(s.step)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-tinta/15 bg-hueso/60 px-3 text-xs font-semibold hover:border-tinta/40"
                aria-label={`Cambiar: ${s.text}`}
              >
                <s.icon size={13} aria-hidden /> {s.text}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {step === 0 ? (
        <section className="flex flex-col gap-3">
          <h3 className="font-display text-xl">¿Qué servicio?</h3>
          <ServiceChoice
            services={services}
            value={serviceId}
            onChange={(id) => {
              setServiceId(id);
              setMinute(null);
              setStep(1);
            }}
          />
          {serviceId ? (
            <Btn variant="secondary" className="self-end" onPress={() => setStep(1)}>
              Continuar
            </Btn>
          ) : null}
        </section>
      ) : null}

      {step === 1 ? (
        <section className="flex flex-col gap-3">
          <h3 className="font-display text-xl">¿Con quién?</h3>
          <StaffChoice
            columns={columns}
            value={staffId}
            onChange={(id) => {
              setStaffId(id);
              setMinute(null);
              setOutside(false);
              setStep(2);
            }}
          />
          <Btn variant="secondary" className="self-end" onPress={() => setStep(2)}>
            Continuar con {staffName}
          </Btn>
        </section>
      ) : null}

      {step === 2 && serviceId ? (
        <section className="flex flex-col gap-3">
          <h3 className="font-display text-xl">¿A qué hora?</h3>
          <SlotPicker
            serviceId={serviceId}
            staffId={staffId}
            date={date}
            today={today}
            onDateChange={(d) => {
              setDate(d);
              setMinute(null);
            }}
            value={outside ? null : minute}
            preferredMinute={date === initialDate ? suggestedMinute : undefined}
            onChange={(m) => {
              setSuggestedMinute(undefined);
              setMinute(m);
              setOutside(false);
              if (m !== null) setStep(3);
            }}
          />
          {staffId !== "any" ? (
            <details className="group rounded-xl border border-tinta/10 bg-hueso/40 p-3">
              <summary className="cursor-pointer text-sm font-semibold text-tinta/80">Agendar fuera del turno</summary>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <TextField className={cx(field.root, "w-36")} value={outsideTime} onChange={setOutsideTime}>
                  <Label className={field.label}>Hora</Label>
                  <Input type="time" step={300} className={cx(field.input, "monto")} />
                </TextField>
                <Btn
                  variant="secondary"
                  isDisabled={!/^\d{2}:\d{2}$/.test(outsideTime)}
                  onPress={() => {
                    setMinute(parseTime(outsideTime));
                    setOutside(true);
                    setStep(3);
                  }}
                >
                  Usar esta hora
                </Btn>
              </div>
              <p className="mt-2 text-xs text-tinta/70">
                Queda registrado que se agendó fuera del turno de {staffName}. Nunca encima de otra cita.
              </p>
            </details>
          ) : null}
        </section>
      ) : null}

      {step === 3 ? (
        <section className="flex flex-col gap-4">
          <h3 className="font-display text-xl">¿Para quién?</h3>
          <ClientPicker value={client} onChange={setClient} />
          <TextField className={field.root} value={notes} onChange={setNotes}>
            <Label className={field.label}>Nota (opcional)</Label>
            <TextArea className={cx(field.input, "h-20 py-2")} maxLength={500} placeholder="Ej. trae referencia del corte" />
          </TextField>
          {service && minute !== null ? (
            <div className="rounded-xl bg-tinta p-4 text-hueso">
              <p className="text-xs uppercase tracking-[0.16em] text-hueso/70">Resumen</p>
              <p className="mt-1 font-display text-2xl leading-tight">
                {formatTime(minute)} · {service.name}
              </p>
              <p className="mt-1 text-sm text-hueso/80">
                {longDate(date)} · {staffName} · <span className="monto">{service.price}</span>
              </p>
            </div>
          ) : null}
          {!clientIsReady(client, false) ? (
            <p id="falta-cliente" className="text-sm text-tinta/70">
              {client.kind === "new" ? "Falta el nombre o el celular (10 dígitos)." : "Busca al cliente o crea uno nuevo."}
            </p>
          ) : null}
          <Btn
            size="xl"
            className="w-full"
            isDisabled={!clientIsReady(client, false)}
            aria-describedby={!clientIsReady(client, false) ? "falta-cliente" : undefined}
            isPending={pending}
            onPress={submit}
          >
            {pending ? "Agendando…" : "Agendar cita"}
          </Btn>
        </section>
      ) : null}

      {step > 0 ? (
        <Btn variant="ghost" className="self-start" onPress={() => setStep((s) => s - 1)}>
          <ChevronLeft size={18} aria-hidden /> Atrás
        </Btn>
      ) : null}
    </div>
  );
}

// ─── Walk-in ─────────────────────────────────────────────────────────────────

function WalkInForm({
  services,
  columns,
  onDone,
}: {
  services: ServiceOption[];
  columns: AgendaColumnView[];
  onDone: () => void;
}) {
  const toast = useToast();
  const [key, setKey] = useState(newKey);
  const [serviceId, setServiceId] = useState<string | null>(services.length === 1 ? (services[0]?.id ?? null) : null);
  const [staffId, setStaffId] = useState("any");
  const [client, setClient] = useState<ClientChoice>({ kind: "none", name: "" });
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!serviceId) return;
    setBusyMessage(null);
    startTransition(async () => {
      const r = await startWalkIn({ serviceId, staffId, client: toActionClient(client), idempotencyKey: key });
      if (r.ok) {
        const who = columns.find((c) => c.staffId === r.data.staffId)?.displayName;
        toast(`Walk-in a las ${r.data.label}${who ? ` con ${who}` : ""}`);
        onDone();
      } else {
        // Nadie libre: el mensaje dice a qué hora se libera. El servidor reconoce un reintento
        // con la misma clave, así que solo se renueva cuando cambia lo que se pide.
        setBusyMessage(r.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Servicio</h3>
        <ServiceChoice
          services={services}
          value={serviceId}
          onChange={(id) => {
            setServiceId(id);
            setKey(newKey());
          }}
          compact
        />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Barbero</h3>
        <StaffChoice
          columns={columns}
          value={staffId}
          onChange={(id) => {
            setStaffId(id);
            setKey(newKey());
          }}
        />
      </section>
      <ClientPicker value={client} onChange={setClient} optional />
      {busyMessage ? (
        <p role="alert" className="rounded-xl border border-alerta/20 bg-alerta/5 p-3 text-sm font-medium text-alerta">
          {busyMessage}
        </p>
      ) : null}
      <Btn variant="success" size="xl" className="w-full" isDisabled={!serviceId || !clientIsReady(client, true)} isPending={pending} onPress={submit}>
        <Zap size={20} aria-hidden /> {pending ? "Buscando silla…" : "Empezar ahora"}
      </Btn>
    </div>
  );
}
