"use client";

import { CalendarPlus, ChevronRight, Coffee, Lock, StickyNote } from "lucide-react";
import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { Button } from "react-aria-components";
import { type AppointmentStatus, NEXT_STEP, NEXT_STEP_LABELS, STATUS_LABELS } from "@/domain/booking/status";
import { formatTime } from "@/domain/staff/schedule";
import { Btn, cx, useToast } from "../_components/ui";
import { AppointmentSheet } from "../agenda/_components/appointment-sheet";
import { longDate } from "../agenda/_components/slot-picker";
import { STATUS_ICON, StatusBadge } from "../agenda/_components/status";
import { setStatus } from "../agenda/actions";
import type { AgendaAppointmentView, AgendaView } from "../agenda/data";

// Mi día: el cliente que toca ahora como un tiquete grande, con un solo botón para
// avanzar ("En silla" → "Terminado"); debajo, lo que sigue y lo ya hecho.

const DONE: readonly AppointmentStatus[] = ["completed", "cancelled", "no_show"];

export function MiDiaView({ view, name, canCharge = false }: { view: AgendaView; name: string; canCharge?: boolean }) {
  const toast = useToast();
  const [appointments, setOptimistic] = useOptimistic(
    view.appointments,
    (state: AgendaAppointmentView[], change: { id: string; status: AppointmentStatus }) =>
      state.map((a) => (a.id === change.id ? { ...a, status: change.status, transitions: [] } : a)),
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const active = appointments.filter((a) => !DONE.includes(a.status));
  const done = appointments.filter((a) => DONE.includes(a.status));
  const current = active.find((a) => a.status === "in_chair") ?? active[0] ?? null;
  const upcoming = active.filter((a) => a !== current);
  const completed = done.filter((a) => a.status === "completed").length;
  const open = appointments.find((a) => a.id === openId) ?? null;

  const next = current ? NEXT_STEP[current.status] : undefined;
  // El barbero no confirma ni marca llegadas: desde "confirmada" o "llegó" pasa directo a la silla.
  const step: AppointmentStatus | undefined =
    current && current.transitions.includes("in_chair") && current.status !== "in_chair" ? "in_chair" : next && current?.transitions.includes(next) ? next : undefined;

  function advance(a: AgendaAppointmentView, to: AppointmentStatus) {
    startTransition(async () => {
      setOptimistic({ id: a.id, status: to });
      const r = await setStatus({ appointmentId: a.id, to });
      if (r.ok) toast(to === "completed" ? `Listo: ${a.clientName ?? "cliente"} terminado` : `${a.clientName ?? "Cliente"} en silla`);
      else toast(r.error, "error");
    });
  }

  const firstName = name.split(" ")[0];
  const StepIcon = step ? STATUS_ICON[step] : null;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 pb-40 pt-4 lg:pt-8">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-botella">{longDate(view.date)}</p>
        <h1 className="font-display text-3xl leading-tight">Hola, {firstName}</h1>
        <p className="text-sm text-tinta/70">
          {active.length === 0 && completed === 0
            ? "Hoy no tienes citas agendadas."
            : `${completed} ${completed === 1 ? "terminada" : "terminadas"} · ${active.length} por atender`}
        </p>
      </header>

      {current ? (
        <section aria-labelledby="ahora" className="relative overflow-hidden rounded-2xl bg-tinta text-hueso shadow-xl">
          {/* Muesca de tiquete */}
          <span className="absolute -left-3 top-[58%] h-6 w-6 rounded-full bg-hueso" aria-hidden />
          <span className="absolute -right-3 top-[58%] h-6 w-6 rounded-full bg-hueso" aria-hidden />
          <div className="flex flex-col gap-3 p-5 pb-4">
            <div className="flex items-center justify-between">
              <p id="ahora" className="text-xs font-semibold uppercase tracking-[0.2em] text-hueso/70">
                {current.status === "in_chair" ? "En silla" : "Sigue"}
              </p>
              <StatusBadge status={current.status} className="bg-hueso/10 text-hueso" />
            </div>
            <p className="font-display text-4xl leading-none">{current.clientName ?? "Sin nombre"}</p>
            <p className="text-hueso/80">{current.serviceName}</p>
            {current.notes ? (
              <p className="flex items-start gap-2 rounded-lg bg-hueso/10 p-2.5 text-sm">
                <StickyNote size={16} className="mt-0.5 shrink-0" aria-hidden /> {current.notes}
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-between border-t border-dashed border-hueso/25 px-5 py-4">
            <span className="monto text-2xl font-semibold">{current.timeLabel}</span>
            <Btn variant="onDark" size="sm" onPress={() => setOpenId(current.id)}>
              Detalle <ChevronRight size={16} aria-hidden />
            </Btn>
          </div>
        </section>
      ) : (
        <section className="grid place-items-center rounded-2xl border border-dashed border-tinta/20 bg-papel px-6 py-12 text-center">
          <Coffee size={32} className="text-tinta/40" aria-hidden />
          <p className="mt-3 font-display text-2xl">Silla libre</p>
          <p className="mt-1 text-sm text-tinta/70">No tienes a nadie pendiente por ahora.</p>
        </section>
      )}

      {upcoming.length > 0 ? (
        <section aria-labelledby="despues" className="flex flex-col gap-2">
          <h2 id="despues" className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
            Después
          </h2>
          <ul className="flex flex-col gap-2">
            {upcoming.map((a) => (
              <li key={a.id}>
                <Row appt={a} onOpen={() => setOpenId(a.id)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="bloqueos" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 id="bloqueos" className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
            Bloqueos
          </h2>
          <Link
            href="/panel/bloqueos"
            className="-mr-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-cuero hover:bg-cuero/5"
          >
            <CalendarPlus size={16} aria-hidden />
            Bloquear tiempo
          </Link>
        </div>
        {view.timeOff.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {view.timeOff.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-xl border border-tinta/10 bg-papel p-3 text-sm">
                <Lock size={16} className="text-tinta/70" aria-hidden />
                <span className="monto font-semibold">
                  {formatTime(t.startMin)}–{formatTime(Math.min(t.endMin, 24 * 60 - 1))}
                </span>
                <span className="text-tinta/70">{t.reason ?? (t.kind === "absence" ? "Ausencia" : "Bloqueado")}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {done.length > 0 ? (
        <details className="rounded-xl border border-tinta/10 bg-papel p-4">
          <summary className="cursor-pointer py-2.5 text-sm font-semibold">
            Hechas y canceladas <span className="monto text-tinta/70">({done.length})</span>
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {done.map((a) => (
              <li key={a.id}>
                <Row appt={a} onOpen={() => setOpenId(a.id)} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Botón grande, fijo sobre la barra inferior: lo único que el barbero toca entre clientes. */}
      {current && step && StepIcon ? (
        <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t border-tinta/10 bg-hueso/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:pl-[calc(72px+1rem)] xl:pl-[calc(232px+1rem)]">
          <div className="mx-auto max-w-xl">
            <Btn variant="success" size="xl" className="h-16 w-full text-xl" isPending={pending} onPress={() => advance(current, step)}>
              <StepIcon size={24} aria-hidden />
              {NEXT_STEP_LABELS[step]}
              <span className="sr-only">: {current.clientName ?? "cliente"}</span>
            </Btn>
          </div>
        </div>
      ) : null}

      <AppointmentSheet
        appointment={open}
        columns={view.columns}
        date={view.date}
        today={view.today}
        onClose={() => setOpenId(null)}
        onOptimistic={(id, status) => setOptimistic({ id, status })}
        canCharge={canCharge}
      />
    </main>
  );
}

function Row({ appt: a, onOpen }: { appt: AgendaAppointmentView; onOpen: () => void }) {
  const Icon = STATUS_ICON[a.status];
  return (
    <Button
      onPress={onOpen}
      className={({ isFocusVisible }) =>
        cx(
          "flex min-h-16 w-full items-center gap-3 rounded-xl border border-tinta/10 bg-papel p-3 text-left transition-colors hover:border-tinta/30",
          isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
        )
      }
    >
      <span className="monto w-12 shrink-0 text-lg font-semibold">{formatTime(a.startMin)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{a.clientName ?? "Sin nombre"}</span>
        <span className="block truncate text-sm text-tinta/70">{a.serviceName}</span>
      </span>
      <span className="flex items-center gap-1 text-xs font-semibold text-tinta/70">
        <Icon size={14} aria-hidden /> {STATUS_LABELS[a.status]}
      </span>
    </Button>
  );
}
