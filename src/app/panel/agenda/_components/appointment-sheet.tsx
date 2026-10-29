"use client";

import { CalendarClock, Phone, StickyNote, Undo2, UserX, X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { Dialog, Heading, Label, Modal, ModalOverlay, Radio, RadioGroup, TextArea, TextField } from "react-aria-components";
import { type AppointmentStatus, NEXT_STEP, NEXT_STEP_LABELS, STATUS_LABELS } from "@/domain/booking/status";
import { Btn, cx, field, Sheet, useToast } from "../../_components/ui";
import { type HistoryEntry, loadHistory, reschedule, setStatus } from "../actions";
import type { AgendaAppointmentView, AgendaColumnView } from "../data";
import { relativeDate, SlotPicker } from "./slot-picker";
import { STATUS_ICON, StatusBadge } from "./status";

// Detalle de una cita: el siguiente paso como botón principal, y a mano reprogramar,
// cancelar, "No vino" y deshacer. Panel lateral en pantallas anchas; hoja en celular.

const SOURCE_LABEL = { staff: "Agendada por el personal", walk_in: "Walk-in", online: "Reserva en línea" } as const;

const CANCEL_OPTIONS = [
  { id: "client", label: "El cliente canceló" },
  { id: "staff", label: "La barbería canceló" },
  { id: "left", label: "Se fue sin atenderse" },
  { id: "duplicate", label: "Cita repetida" },
] as const;
type CancelChoice = (typeof CANCEL_OPTIONS)[number]["id"];

/** Deshacer: ir hacia atrás en el ciclo el mismo día. */
const UNDO: Partial<Record<AppointmentStatus, AppointmentStatus>> = {
  arrived: "confirmed",
  in_chair: "arrived",
  no_show: "arrived",
};

export function AppointmentSheet({
  appointment,
  columns,
  date,
  today,
  onClose,
  onOptimistic,
}: {
  appointment: AgendaAppointmentView | null;
  columns: AgendaColumnView[];
  date: string;
  today: string;
  onClose: () => void;
  onOptimistic?: (id: string, status: AppointmentStatus) => void;
}) {
  const [mode, setMode] = useState<"detail" | "reschedule">("detail");
  return (
    <Sheet
      isOpen={appointment !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setMode("detail");
        }
      }}
      drawer
      title={appointment ? (appointment.clientName ?? "Sin nombre") : ""}
      description={appointment ? `${appointment.serviceName} · ${appointment.staffName}` : undefined}
    >
      {appointment ? (
        mode === "detail" ? (
          <Detail
            key={appointment.id}
            appointment={appointment}
            onReschedule={() => setMode("reschedule")}
            onClose={onClose}
            onOptimistic={onOptimistic}
          />
        ) : (
          <Reschedule
            appointment={appointment}
            columns={columns}
            date={date < today ? today : date}
            today={today}
            onCancel={() => setMode("detail")}
            onDone={() => {
              setMode("detail");
              onClose();
            }}
          />
        )
      ) : null}
    </Sheet>
  );
}

function Detail({
  appointment: a,
  onReschedule,
  onClose,
  onOptimistic,
}: {
  appointment: AgendaAppointmentView;
  onReschedule: () => void;
  onClose: () => void;
  onOptimistic?: (id: string, status: AppointmentStatus) => void;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<"cancel" | "no_show" | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    loadHistory(a.id).then((r) => alive && setHistory(r.ok ? r.data : []));
    return () => {
      alive = false;
    };
  }, [a.id, a.status]);

  const next = NEXT_STEP[a.status];
  const canNext = next !== undefined && a.transitions.includes(next);
  const undo = UNDO[a.status];
  const canUndo = undo !== undefined && a.transitions.includes(undo);

  function move(to: AppointmentStatus, extra?: { cancelReason?: CancelChoice; note?: string }) {
    startTransition(async () => {
      onOptimistic?.(a.id, to);
      const r = await setStatus({ appointmentId: a.id, to, ...extra });
      if (r.ok) {
        toast(`${a.clientName ?? "Cita"}: ${STATUS_LABELS[to].toLowerCase()}`);
        if (to === "cancelled" || to === "no_show" || to === "completed") onClose();
      } else {
        toast(r.error, "error");
      }
      setConfirm(null);
    });
  }

  const NextIcon = next ? STATUS_ICON[next] : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={a.status} />
        <span className="text-xs text-tinta/70">{SOURCE_LABEL[a.source]}</span>
      </div>

      <dl className="grid grid-cols-2 gap-3 rounded-xl border border-tinta/10 bg-hueso/40 p-4">
        <div>
          <dt className="text-xs text-tinta/70">Hora</dt>
          <dd className="monto text-lg font-semibold">{a.timeLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-tinta/70">Precio</dt>
          <dd className="monto text-lg font-semibold">{a.price}</dd>
        </div>
        {a.clientPhone ? (
          <div className="col-span-2">
            <dt className="text-xs text-tinta/70">Celular</dt>
            <dd>
              {a.clientPhoneHref ? (
                <a href={a.clientPhoneHref} className="monto inline-flex min-h-11 items-center gap-2 font-semibold text-cuero underline-offset-4 hover:underline">
                  <Phone size={16} aria-hidden /> {a.clientPhone}
                </a>
              ) : (
                <span className="monto">{a.clientPhone}</span>
              )}
            </dd>
          </div>
        ) : null}
        {a.notes ? (
          <div className="col-span-2">
            <dt className="flex items-center gap-1 text-xs text-tinta/70">
              <StickyNote size={12} aria-hidden /> Nota
            </dt>
            <dd className="text-sm">{a.notes}</dd>
          </div>
        ) : null}
      </dl>

      {canNext && next ? (
        <Btn
          size="xl"
          variant={next === "completed" || next === "in_chair" ? "success" : "primary"}
          className="w-full"
          isPending={pending}
          onPress={() => move(next)}
        >
          {NextIcon ? <NextIcon size={22} aria-hidden /> : null}
          {NEXT_STEP_LABELS[next]}
        </Btn>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        {a.canReschedule ? (
          <Btn variant="secondary" onPress={onReschedule} isDisabled={pending}>
            <CalendarClock size={18} aria-hidden /> Reprogramar
          </Btn>
        ) : null}
        {a.transitions.includes("no_show") ? (
          <Btn variant="secondary" onPress={() => setConfirm("no_show")} isDisabled={pending}>
            <UserX size={18} aria-hidden /> No vino
          </Btn>
        ) : null}
        {a.transitions.includes("cancelled") ? (
          <Btn variant="danger" onPress={() => setConfirm("cancel")} isDisabled={pending}>
            <X size={18} aria-hidden /> Cancelar cita
          </Btn>
        ) : null}
        {canUndo && undo ? (
          <Btn variant="ghost" onPress={() => move(undo)} isDisabled={pending}>
            <Undo2 size={18} aria-hidden /> Volver a «{STATUS_LABELS[undo]}»
          </Btn>
        ) : null}
      </div>

      <section aria-labelledby="historial" className="flex flex-col gap-2">
        <h3 id="historial" className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
          Historial
        </h3>
        {history === null ? (
          <div className="h-16 animate-pulse rounded-lg bg-tinta/5" aria-label="Cargando historial" />
        ) : history.length === 0 ? (
          <p className="text-sm text-tinta/70">Sin movimientos.</p>
        ) : (
          <ol className="relative flex flex-col gap-3 border-l border-tinta/15 pl-4">
            {history.map((h, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-papel bg-botella" aria-hidden />
                <p className="text-sm font-semibold">{h.label}</p>
                <p className="text-xs text-tinta/70">
                  <span className="monto">{h.at.slice(11)}</span> · {h.actor}
                </p>
                {h.reason ? <p className="mt-0.5 text-sm text-tinta/80">{h.reason}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <ConfirmDialog
        kind={confirm}
        name={a.clientName ?? "esta cita"}
        pending={pending}
        onCancel={() => setConfirm(null)}
        onConfirm={(extra) => move(confirm === "cancel" ? "cancelled" : "no_show", extra)}
      />
    </div>
  );
}

function ConfirmDialog({
  kind,
  name,
  pending,
  onCancel,
  onConfirm,
}: {
  kind: "cancel" | "no_show" | null;
  name: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (extra: { cancelReason?: CancelChoice; note?: string }) => void;
}) {
  const [reason, setReason] = useState<CancelChoice>("client");
  const [note, setNote] = useState("");
  return (
    <ModalOverlay
      isOpen={kind !== null}
      onOpenChange={(open) => !open && onCancel()}
      isDismissable={!pending}
      className="fixed inset-0 z-[55] grid place-items-center bg-tinta/40 p-4 data-[entering]:animate-fade-in"
    >
      <Modal className="w-full max-w-sm rounded-2xl bg-papel p-5 shadow-2xl data-[entering]:animate-pop-in">
        <Dialog role="alertdialog" aria-describedby="confirmar-detalle" className="flex flex-col gap-4 outline-none">
          <Heading slot="title" className="font-display text-2xl leading-tight">
            {kind === "cancel" ? `¿Cancelar la cita de ${name}?` : `¿${name} no vino?`}
          </Heading>
          {kind === "cancel" ? (
            <>
              <RadioGroup value={reason} onChange={(v) => setReason(v as CancelChoice)} className="flex flex-col gap-1.5">
                <Label className={field.label}>Motivo</Label>
                {CANCEL_OPTIONS.map((o) => (
                  <Radio
                    key={o.id}
                    value={o.id}
                    className={({ isSelected, isFocusVisible }) =>
                      cx(
                        "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm",
                        isSelected ? "border-cuero bg-cuero/8 font-semibold" : "border-tinta/15",
                        isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
                      )
                    }
                  >
                    {({ isSelected }) => (
                      <>
                        <span className={cx("h-4 w-4 rounded-full border-2", isSelected ? "border-[5px] border-cuero" : "border-tinta/50")} aria-hidden />
                        {o.label}
                      </>
                    )}
                  </Radio>
                ))}
              </RadioGroup>
              <TextField className={field.root} value={note} onChange={setNote}>
                <Label className={field.label}>Nota (opcional)</Label>
                <TextArea className={cx(field.input, "h-16 py-2")} maxLength={300} />
              </TextField>
              <p id="confirmar-detalle" className="text-xs text-tinta/70">
                La cita queda en el historial; no se borra.
              </p>
            </>
          ) : (
            <p id="confirmar-detalle" className="text-sm text-tinta/80">
              Queda registrado como inasistencia. Se puede deshacer hoy si llega.
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Btn variant="ghost" onPress={onCancel} isDisabled={pending} autoFocus>
              Volver
            </Btn>
            <Btn
              variant="danger"
              isPending={pending}
              onPress={() => onConfirm(kind === "cancel" ? { cancelReason: reason, note: note.trim() || undefined } : {})}
            >
              {kind === "cancel" ? "Sí, cancelar" : "Marcar «No vino»"}
            </Btn>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function Reschedule({
  appointment: a,
  columns,
  date: initialDate,
  today,
  onCancel,
  onDone,
}: {
  appointment: AgendaAppointmentView;
  columns: AgendaColumnView[];
  date: string;
  today: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [staffId, setStaffId] = useState(a.staffId);
  const [date, setDate] = useState(initialDate);
  const [minute, setMinute] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const staffOptions = columns.some((c) => c.staffId === a.staffId) ? columns : [{ staffId: a.staffId, displayName: a.staffName, blocks: [] }, ...columns];

  function submit() {
    if (minute === null) return;
    startTransition(async () => {
      const r = await reschedule({ appointmentId: a.id, staffId, date, minute });
      if (r.ok) {
        toast(`Reprogramada: ${relativeDate(date, today).toLowerCase()} a las ${r.data.label}`);
        onDone();
      } else {
        toast(r.error, "error");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <RadioGroup aria-label="Barbero" value={staffId} onChange={(v) => { setStaffId(v); setMinute(null); }} className="flex flex-wrap gap-2">
        {staffOptions.map((c) => (
          <Radio
            key={c.staffId}
            value={c.staffId}
            className={({ isSelected, isFocusVisible }) =>
              cx(
                "inline-flex h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-semibold",
                isSelected ? "border-cuero bg-cuero text-hueso" : "border-tinta/15 bg-papel",
                isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
              )
            }
          >
            {c.displayName}
          </Radio>
        ))}
      </RadioGroup>
      <SlotPicker
        serviceId={a.serviceId}
        staffId={staffId}
        date={date}
        today={today}
        onDateChange={(d) => {
          setDate(d);
          setMinute(null);
        }}
        value={minute}
        onChange={(m) => setMinute(m)}
        excludeAppointmentId={a.id}
      />
      <div className="sticky bottom-0 flex gap-2 bg-papel pt-2">
        <Btn variant="ghost" onPress={onCancel} isDisabled={pending}>
          Volver
        </Btn>
        <Btn className="flex-1" size="lg" isDisabled={minute === null} isPending={pending} onPress={submit}>
          Mover cita
        </Btn>
      </div>
    </div>
  );
}
