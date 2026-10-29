"use client";

import { CalendarDays, ChevronLeft, ChevronRight, Lock, Plus, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useOptimistic, useRef, useState } from "react";
import { parseDate } from "@internationalized/date";
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  Dialog,
  DialogTrigger,
  Heading,
  Popover,
  ToggleButton,
  ToggleButtonGroup,
} from "react-aria-components";
import { addDays } from "@/domain/booking/clock";
import { type AppointmentStatus, STATUS_LABELS } from "@/domain/booking/status";
import { formatTime } from "@/domain/staff/schedule";
import { Btn, cx } from "../../_components/ui";
import type { AgendaAppointmentView, AgendaView } from "../data";
import { AppointmentSheet } from "./appointment-sheet";
import { type BookingMode, type BookingPrefill, BookingSheet, initials } from "./booking-sheet";
import { longDate, relativeDate } from "./slot-picker";
import { BLOCK_STYLE, STATUS_ICON, StatusBadge } from "./status";

// La agenda del día: una columna por barbero, 15 minutos por renglón, la línea de "ahora"
// y la limpieza entre citas dibujada aparte. En celular se ve un barbero a la vez.

const OFF_GRID: readonly AppointmentStatus[] = ["cancelled", "no_show"];

export function AgendaBoard({ view }: { view: AgendaView }) {
  const router = useRouter();
  const [appointments, setOptimistic] = useOptimistic(
    view.appointments,
    (state: AgendaAppointmentView[], change: { id: string; status: AppointmentStatus }) =>
      state.map((a) => (a.id === change.id ? { ...a, status: change.status, transitions: [] } : a)),
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [booking, setBooking] = useState<{ mode: BookingMode; prefill?: BookingPrefill } | null>(null);
  const defaultStaff = view.columns.find((c) => c.staffId === view.viewer.staffId)?.staffId ?? view.columns[0]?.staffId ?? "";
  const [phoneStaff, setPhoneStaff] = useState(defaultStaff);
  const visibleStaff = view.columns.some((c) => c.staffId === phoneStaff) ? phoneStaff : defaultStaff;

  const isToday = view.date === view.today;
  const nowMin = useNowMinute(view.dayStartMs, view.nowMs);
  const open = appointments.find((a) => a.id === openId) ?? null;

  const onGrid = appointments.filter((a) => !OFF_GRID.includes(a.status));
  const offGrid = appointments.filter((a) => OFF_GRID.includes(a.status));

  // Rango visible: los turnos y las citas del día, redondeado a horas (mínimo 8:00–20:00).
  const [startMin, endMin] = useMemo(() => {
    let lo = 8 * 60;
    let hi = 20 * 60;
    for (const c of view.columns) for (const b of c.blocks) (lo = Math.min(lo, b.startMin)), (hi = Math.max(hi, b.endMin));
    for (const a of onGrid) (lo = Math.min(lo, a.startMin)), (hi = Math.max(hi, a.endMin));
    return [Math.floor(lo / 60) * 60, Math.min(24 * 60, Math.ceil(hi / 60) * 60)];
  }, [view.columns, onGrid]);
  const hours = Array.from({ length: (endMin - startMin) / 60 }, (_, i) => startMin + i * 60);
  const y = (m: number) => `calc(var(--hour) * ${(m - startMin) / 60})`;
  const h = (from: number, to: number) => `calc(var(--hour) * ${(to - from) / 60})`;

  // Al abrir hoy, llevar la vista a una hora antes de "ahora".
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !isToday) return;
    const hourPx = parseFloat(getComputedStyle(el).getPropertyValue("--hour")) || 96;
    el.scrollTop = Math.max(0, ((nowMin - 60 - startMin) / 60) * hourPx);
    // Solo al cambiar de día.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.date]);

  const counts = {
    total: onGrid.length,
    waiting: onGrid.filter((a) => a.status === "arrived").length,
    inChair: onGrid.filter((a) => a.status === "in_chair").length,
  };

  function pickEmpty(staffId: string, e: React.MouseEvent<HTMLDivElement>) {
    if (!view.viewer.canManageAll) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minute = startMin + Math.floor((((e.clientY - rect.top) / rect.height) * (endMin - startMin)) / 15) * 15;
    setBooking({ mode: "appointment", prefill: { staffId, minute } });
  }

  const goTo = (date: string) => router.push(date === view.today ? "/panel/agenda" : `/panel/agenda?fecha=${date}`);

  return (
    <main className="flex flex-col gap-4 px-4 pb-28 pt-4 md:pb-6 lg:px-8 lg:pt-8">
      {/* Encabezado: día y acciones */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xs font-semibold uppercase tracking-[0.2em] text-botella">Agenda</h1>
          <div className="flex items-center gap-1">
            <Link
              href={`/panel/agenda?fecha=${addDays(view.date, -1)}`}
              className="-ml-2 grid h-11 w-11 place-items-center rounded-lg text-tinta/70 hover:bg-tinta/5"
              aria-label="Día anterior"
            >
              <ChevronLeft size={22} aria-hidden />
            </Link>
            <DayPicker date={view.date} today={view.today} onPick={goTo} />
            <Link
              href={`/panel/agenda?fecha=${addDays(view.date, 1)}`}
              className="grid h-11 w-11 place-items-center rounded-lg text-tinta/70 hover:bg-tinta/5"
              aria-label="Día siguiente"
            >
              <ChevronRight size={22} aria-hidden />
            </Link>
            {!isToday ? (
              <Link href="/panel/agenda" className="ml-1 inline-flex h-9 items-center rounded-full border border-tinta/15 px-3 text-sm font-semibold hover:border-tinta/40">
                Hoy
              </Link>
            ) : null}
          </div>
          <p className="text-sm text-tinta/70" aria-live="polite">
            {counts.total === 0 ? "Sin citas" : `${counts.total} ${counts.total === 1 ? "cita" : "citas"}`}
            {counts.waiting > 0 ? ` · ${counts.waiting} esperando` : ""}
            {counts.inChair > 0 ? ` · ${counts.inChair} en silla` : ""}
          </p>
        </div>
        {view.viewer.canManageAll ? (
          <div className="flex items-center gap-2">
            <Btn variant="success" className="max-md:hidden" onPress={() => setBooking({ mode: "walk_in" })}>
              <Zap size={18} aria-hidden /> Walk-in
            </Btn>
            <Btn onPress={() => setBooking({ mode: "appointment" })}>
              <Plus size={18} aria-hidden /> Nueva cita
            </Btn>
          </div>
        ) : null}
      </header>

      {view.columns.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-tinta/20 bg-papel px-6 py-16 text-center">
          <CalendarDays size={32} className="text-tinta/40" aria-hidden />
          <p className="mt-3 font-display text-2xl">Nadie trabaja este día</p>
          <p className="mt-1 max-w-sm text-sm text-tinta/70">Los turnos de cada barbero se configuran en Personal → Horario.</p>
        </div>
      ) : (
        <>
          {/* Celular: un barbero a la vez */}
          {view.columns.length > 1 ? (
            <ToggleButtonGroup
              aria-label="Barbero"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[visibleStaff]}
              onSelectionChange={(keys) => {
                const k = [...keys][0];
                if (k !== undefined) setPhoneStaff(String(k));
              }}
              className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:hidden"
            >
              {view.columns.map((c) => {
                const n = onGrid.filter((a) => a.staffId === c.staffId).length;
                return (
                  <ToggleButton
                    key={c.staffId}
                    id={c.staffId}
                    className={({ isSelected, isFocusVisible }) =>
                      cx(
                        "inline-flex h-11 shrink-0 items-center gap-2 rounded-full border pl-1.5 pr-4 text-sm font-semibold transition-colors",
                        isSelected ? "border-tinta bg-tinta text-hueso" : "border-tinta/15 bg-papel",
                        isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
                      )
                    }
                  >
                    {({ isSelected }) => (
                      <>
                        <span className={cx("grid h-8 w-8 place-items-center rounded-full text-xs", isSelected ? "bg-hueso/15" : "bg-botella text-hueso")} aria-hidden>
                          {initials(c.displayName)}
                        </span>
                        {c.displayName.split(" ")[0]}
                        <span className={cx("monto text-xs", isSelected ? "text-hueso/70" : "text-tinta/70")} aria-hidden>
                          {n}
                        </span>
                        <span className="sr-only"> {n} {n === 1 ? "cita" : "citas"}</span>
                      </>
                    )}
                  </ToggleButton>
                );
              })}
            </ToggleButtonGroup>
          ) : null}

          <div
            ref={scroller}
            className="relative h-[calc(100dvh-17rem)] min-h-[420px] overflow-auto rounded-2xl border border-tinta/10 bg-papel shadow-sm [--hour:96px] md:[--hour:112px] lg:h-[calc(100dvh-12rem)]"
          >
            <div className="flex min-w-full md:w-max">
              {/* Horas */}
              <div className="sticky left-0 z-20 w-14 shrink-0 border-r border-tinta/10 bg-papel">
                <div className="sticky top-0 z-10 h-14 border-b border-tinta/10 bg-papel" />
                <div className="relative" style={{ height: h(startMin, endMin) }}>
                  {hours.map((m) => (
                    <span key={m} className="monto absolute right-2 -translate-y-1/2 text-[11px] text-tinta/70" style={{ top: y(m) }}>
                      {m === startMin ? "" : formatTime(m)}
                    </span>
                  ))}
                </div>
              </div>

              {view.columns.map((col) => {
                const colAppts = onGrid.filter((a) => a.staffId === col.staffId);
                const colOff = view.timeOff.filter((t) => t.staffId === null || t.staffId === col.staffId);
                return (
                  <section
                    key={col.staffId}
                    aria-label={`Agenda de ${col.displayName}`}
                    className={cx(
                      "relative flex-1 border-r border-tinta/10 last:border-r-0 md:min-w-[168px] md:flex-none md:basis-[200px] xl:basis-[220px]",
                      col.staffId === visibleStaff ? "block" : "hidden md:block",
                    )}
                  >
                    <div className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-tinta/10 bg-papel/95 px-3 backdrop-blur">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-botella text-xs font-semibold text-hueso" aria-hidden>
                        {initials(col.displayName)}
                      </span>
                      <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold">{col.displayName}</h2>
                        <p className="text-[11px] text-tinta/70">
                          {col.blocks.length === 0 ? "No trabaja hoy" : col.blocks.map((b) => `${formatTime(b.startMin)}–${formatTime(b.endMin)}`).join(" · ")}
                        </p>
                      </div>
                    </div>

                    <div className="relative bg-tinta/[0.035]" style={{ height: h(startMin, endMin) }}>
                      {/* Turno (fondo claro) y renglones */}
                      {col.blocks.map((b) => (
                        <div key={b.startMin} className="absolute inset-x-0 bg-papel" style={{ top: y(b.startMin), height: h(b.startMin, b.endMin) }} aria-hidden />
                      ))}
                      {hours.map((m) => (
                        <div key={m} aria-hidden>
                          <div className="absolute inset-x-0 border-t border-tinta/10" style={{ top: y(m) }} />
                          <div className="absolute inset-x-0 border-t border-dashed border-tinta/[0.06]" style={{ top: y(m + 30) }} />
                        </div>
                      ))}
                      {/* Toque en un hueco: nueva cita a esa hora (el botón "Nueva cita" es la vía accesible). */}
                      <div className="absolute inset-0" onClick={(e) => pickEmpty(col.staffId, e)} aria-hidden />

                      {colOff.map((t) => (
                        <div
                          key={t.id}
                          className="absolute inset-x-1 flex items-start gap-1.5 overflow-hidden rounded-lg border border-tinta/10 bg-[repeating-linear-gradient(135deg,rgb(28_26_23/0.05)_0_6px,transparent_6px_12px)] p-2 text-xs text-tinta/70"
                          style={{ top: y(Math.max(t.startMin, startMin)), height: h(Math.max(t.startMin, startMin), Math.min(t.endMin, endMin)) }}
                        >
                          <Lock size={12} className="mt-0.5 shrink-0" aria-hidden />
                          <span className="font-semibold">
                            {t.staffId === null ? "Sede cerrada" : t.kind === "absence" ? "Ausencia" : "Bloqueado"}
                            {t.reason ? <span className="font-normal"> · {t.reason}</span> : null}
                          </span>
                        </div>
                      ))}

                      {colAppts.map((a) => (
                        <AppointmentBlock key={a.id} appt={a} top={y(a.startMin)} height={h(a.startMin, a.serviceEndMin)} bufferTop={y(a.serviceEndMin)} bufferHeight={h(a.serviceEndMin, a.endMin)} onOpen={() => setOpenId(a.id)} />
                      ))}

                      {isToday && nowMin >= startMin && nowMin <= endMin ? (
                        <div className="pointer-events-none absolute inset-x-0 z-[5]" style={{ top: y(nowMin) }} aria-hidden>
                          <div className="h-0.5 bg-botella" />
                          <div className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full bg-botella" />
                        </div>
                      ) : null}
                    </div>
                  </section>
                );
              })}
            </div>
            {isToday ? (
              <p className="sr-only" aria-live="off">
                Hora actual {formatTime(nowMin)}
              </p>
            ) : null}
          </div>
        </>
      )}

      {offGrid.length > 0 ? (
        <details className="rounded-xl border border-tinta/10 bg-papel p-4">
          <summary className="cursor-pointer py-2.5 text-sm font-semibold">
            Canceladas y no vinieron <span className="monto text-tinta/70">({offGrid.length})</span>
          </summary>
          <ul className="mt-3 flex flex-col divide-y divide-tinta/10">
            {offGrid.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => setOpenId(a.id)} className="flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left">
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{a.clientName ?? "Sin nombre"}</span>
                    <span className="monto text-sm text-tinta/70">
                      {formatTime(a.startMin)} · {a.serviceName} · {a.staffName}
                    </span>
                  </span>
                  <StatusBadge status={a.status} />
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Walk-in en celular: botón flotante sobre la barra inferior */}
      {view.viewer.canManageAll ? (
        <Btn
          variant="success"
          size="lg"
          aria-label="Walk-in: empezar ahora"
          className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-30 h-14 rounded-full px-5 shadow-xl md:hidden!"
          onPress={() => setBooking({ mode: "walk_in" })}
        >
          <Zap size={20} aria-hidden /> Walk-in
        </Btn>
      ) : null}

      <BookingSheet
        mode={booking?.mode ?? "appointment"}
        isOpen={booking !== null}
        onOpenChange={(o) => !o && setBooking(null)}
        services={view.services}
        columns={view.columns}
        date={view.date}
        today={view.today}
        prefill={booking?.prefill}
      />
      <AppointmentSheet
        appointment={open}
        columns={view.columns}
        date={view.date}
        today={view.today}
        onClose={() => setOpenId(null)}
        onOptimistic={(id, status) => setOptimistic({ id, status })}
      />
    </main>
  );
}

function AppointmentBlock({
  appt: a,
  top,
  height,
  bufferTop,
  bufferHeight,
  onOpen,
}: {
  appt: AgendaAppointmentView;
  top: string;
  height: string;
  bufferTop: string;
  bufferHeight: string;
  onOpen: () => void;
}) {
  const Icon = STATUS_ICON[a.status];
  const short = a.serviceEndMin - a.startMin < 30;
  return (
    <>
      {a.endMin > a.serviceEndMin ? (
        <div
          className="absolute inset-x-1.5 rounded-b-md bg-[repeating-linear-gradient(135deg,rgb(28_26_23/0.06)_0_4px,transparent_4px_8px)]"
          style={{ top: bufferTop, height: bufferHeight }}
          title="Limpieza"
          aria-hidden
        />
      ) : null}
      <Button
        onPress={onOpen}
        aria-label={`${formatTime(a.startMin)}, ${a.clientName ?? "sin nombre"}, ${a.serviceName}, ${STATUS_LABELS[a.status]}`}
        className={({ isFocusVisible, isPressed }) =>
          cx(
            "absolute inset-x-1 z-[6] flex flex-col overflow-hidden rounded-lg px-2 py-1 text-left transition-[transform,box-shadow] duration-150 ease-[var(--ease-villa)] hover:shadow-md",
            BLOCK_STYLE[a.status],
            isPressed && "scale-[.98]",
            isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
          )
        }
        style={{ top, height, minHeight: 24 }}
      >
        <span className="flex min-w-0 items-center gap-1 text-xs">
          <Icon size={12} strokeWidth={2.25} className="shrink-0" aria-hidden />
          <span className="monto shrink-0 font-semibold">{formatTime(a.startMin)}</span>
          <span className="truncate font-semibold">{a.clientName ?? "Sin nombre"}</span>
        </span>
        {!short ? <span className="truncate text-xs opacity-80">{a.serviceName}</span> : null}
      </Button>
    </>
  );
}

function DayPicker({ date, today, onPick }: { date: string; today: string; onPick: (date: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button className="rounded-lg px-1 text-left outline-none data-[focus-visible]:outline-3 data-[focus-visible]:outline-cuero" aria-label={`${relativeDate(date, today) === longDate(date) ? longDate(date) : `${relativeDate(date, today)}, ${longDate(date)}`}. Cambiar día`}>
        <span className="font-display text-3xl leading-tight">{relativeDate(date, today)}</span>
        {relativeDate(date, today) !== longDate(date) ? (
          <span className="ml-2 hidden text-sm text-tinta/70 sm:inline">{longDate(date)}</span>
        ) : null}
      </Button>
      <Popover className="rounded-2xl border border-tinta/10 bg-papel p-3 shadow-xl data-[entering]:animate-pop-in">
        <Dialog aria-label="Elegir día" className="outline-none">
          <Calendar
            aria-label="Calendario"
            value={parseDate(date)}
            onChange={(d) => {
              setOpen(false);
              onPick(d.toString());
            }}
          >
            <header className="mb-2 flex items-center justify-between">
              <Button slot="previous" className="grid h-10 w-10 place-items-center rounded-lg hover:bg-tinta/5" aria-label="Mes anterior">
                <ChevronLeft size={18} aria-hidden />
              </Button>
              <Heading className="font-semibold capitalize" />
              <Button slot="next" className="grid h-10 w-10 place-items-center rounded-lg hover:bg-tinta/5" aria-label="Mes siguiente">
                <ChevronRight size={18} aria-hidden />
              </Button>
            </header>
            <CalendarGrid className="border-separate border-spacing-0.5">
              {(d) => (
                <CalendarCell
                  date={d}
                  className={({ isSelected, isOutsideMonth, isFocusVisible }) =>
                    cx(
                      "monto grid h-10 w-10 cursor-pointer place-items-center rounded-lg text-sm",
                      isOutsideMonth && "invisible",
                      isSelected ? "bg-cuero font-semibold text-hueso" : "hover:bg-tinta/5",
                      d.toString() === today && !isSelected && "font-semibold text-botella ring-1 ring-botella/40",
                      isFocusVisible && "outline-3 outline-offset-1 outline-cuero",
                    )
                  }
                />
              )}
            </CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

/** Minuto local actual, actualizado cada 30 s (arranca con la hora del servidor para no desajustar la hidratación). */
function useNowMinute(dayStartMs: number, serverNowMs: number): number {
  const [nowMs, setNowMs] = useState(serverNowMs);
  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return Math.floor((nowMs - dayStartMs) / 60_000);
}
