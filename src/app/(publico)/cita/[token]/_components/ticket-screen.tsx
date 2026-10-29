"use client";

import { CalendarPlus, CalendarSync, MapPin, MessageCircle, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Label, Radio, RadioGroup, TextArea, TextField } from "react-aria-components";
import { Btn, cx, field, Sheet, useToast } from "@/app/panel/_components/ui";
import { RadioDot, radioCard } from "@/app/panel/_manage/controls";
import type { TicketView } from "../../../data";
import { cancelByToken, loadRescheduleDays, loadRescheduleSlots, rescheduleByToken } from "../../../actions";
import { SlotChooser } from "../../../_components/slot-chooser";
import { stampFor, Ticket } from "../../../_components/ticket";
import { isError, linkBtn, safeCall, shortWeekdayDay, type SlotView } from "../../../_lib/ui";

// Ticket + acciones de la cita (calendario, cómo llegar, reprogramar, cancelar).
// Las acciones que no se permiten no se muestran: se dice por qué.

export function TicketScreen({
  token,
  ticket,
  today,
  whatsappUrl,
}: {
  token: string;
  ticket: TicketView;
  today: string;
  whatsappUrl: string | null;
}) {
  // Cancelar revoca el enlace: no se recarga la página (daría 404); se muestra el estado aquí.
  const [cancelled, setCancelled] = useState(ticket.status === "cancelled");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reschedOpen, setReschedOpen] = useState(false);
  const cancelledNote = useRef<HTMLParagraphElement>(null);
  const status = cancelled ? "cancelled" : ticket.status;
  const active = status === "pending" || status === "confirmed";

  return (
    <div className="flex flex-col gap-6">
      <Ticket
        headingId="ticket-h"
        data={{
          code: ticket.code,
          timeLabel: ticket.timeLabel,
          dateLabel: ticket.dateLabel,
          serviceName: ticket.serviceName,
          staffName: ticket.staffName,
          durationMin: ticket.durationMin,
          priceLabel: ticket.priceLabel,
          address: ticket.address,
          stamp: stampFor(status, cancelled ? "Cancelada" : ticket.statusLabel),
        }}
      />

      {cancelled ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <p ref={cancelledNote} tabIndex={-1} role="status" className="font-semibold outline-none">
            Esta cita está cancelada.
          </p>
          <Link href="/reservar" className={linkBtn("primary", "lg")}>
            Reservar otra cita
          </Link>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-3">
          {active ? (
            <a href={ticket.icsUrl} download className={linkBtn("secondary", "lg", "w-full")}>
              <CalendarPlus size={18} aria-hidden /> Agregar al calendario
            </a>
          ) : null}
          {ticket.mapsUrl ? (
            <a href={ticket.mapsUrl} target="_blank" rel="noopener noreferrer" className={linkBtn("secondary", "lg", "w-full")}>
              <MapPin size={18} aria-hidden /> Cómo llegar
            </a>
          ) : null}

          {active ? (
            <div className="mt-2 grid grid-cols-2 gap-3">
              {ticket.reschedule.allowed ? (
                <Btn variant="secondary" size="lg" onPress={() => setReschedOpen(true)}>
                  <CalendarSync size={18} aria-hidden /> Reprogramar
                </Btn>
              ) : null}
              {ticket.cancel.allowed ? (
                <Btn variant="danger" size="lg" className={cx(!ticket.reschedule.allowed && "col-span-2")} onPress={() => setCancelOpen(true)}>
                  <X size={18} aria-hidden /> Cancelar
                </Btn>
              ) : null}
            </div>
          ) : null}

          {active && !ticket.reschedule.allowed && ticket.reschedule.reason ? (
            <p className="text-sm text-tinta/80">{ticket.reschedule.reason}</p>
          ) : null}
          {active && !ticket.cancel.allowed ? (
            <p className="text-sm text-tinta/80">Esta cita ya no se puede cancelar desde aquí. Si no puedes venir, escríbenos.</p>
          ) : null}
          {active && (!ticket.cancel.allowed || !ticket.reschedule.allowed) && whatsappUrl ? (
            <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className={linkBtn("ghost", "md", "self-start -ml-1")}>
              <MessageCircle size={18} aria-hidden /> Escríbenos por WhatsApp
            </a>
          ) : null}
        </div>
      )}

      <CancelSheet
        isOpen={cancelOpen}
        onOpenChange={setCancelOpen}
        token={token}
        ticket={ticket}
        onCancelled={() => {
          setCancelOpen(false);
          setCancelled(true);
          // El botón que abrió la hoja ya no existe: el foco va al aviso, después de que la hoja cierre.
          setTimeout(() => cancelledNote.current?.focus(), 300);
        }}
      />
      <RescheduleSheet
        isOpen={reschedOpen}
        onOpenChange={setReschedOpen}
        token={token}
        today={today}
      />
    </div>
  );
}

// ─── Cancelar ────────────────────────────────────────────────────────────────

const REASONS = [
  { id: "algo", label: "Me salió algo" },
  { id: "no-necesito", label: "Ya no lo necesito" },
  { id: "hora", label: "Me equivoqué de hora" },
  { id: "otro", label: "Otro" },
] as const;

function CancelSheet({
  isOpen,
  onOpenChange,
  token,
  ticket,
  onCancelled,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  ticket: TicketView;
  onCancelled: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function cancel() {
    setPending(true);
    setError(null);
    const label = REASONS.find((r) => r.id === reason)?.label;
    const text = reason === "otro" ? other.trim() || "Otro" : label;
    const r = await safeCall(() => cancelByToken({ token, reason: text?.slice(0, 200) }));
    setPending(false);
    if (r.ok) {
      toast("Cancelamos tu cita. Cuando quieras volver, aquí estamos.");
      onCancelled();
    } else {
      setError(r.error);
    }
  }

  return (
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange} title="¿Cancelar tu cita?" description={`${ticket.serviceName}, ${ticket.dateLabel} a las ${ticket.timeLabel}`}>
      <div className="flex flex-col gap-5">
        {ticket.cancel.late ? (
          <p className="rounded-xl border border-alerta/30 bg-alerta/5 p-3 text-sm font-medium text-alerta">
            Faltan menos de {ticket.cancel.freeCancelHours} horas. Puedes cancelar, pero quedará registrada como cancelación tardía.
          </p>
        ) : null}

        <RadioGroup value={reason} onChange={setReason} className="flex flex-col gap-2">
          <Label className={field.label}>Motivo (opcional)</Label>
          {REASONS.map((r) => (
            <Radio key={r.id} value={r.id} className={cx(radioCard, "group")}>
              <RadioDot />
              {r.label}
            </Radio>
          ))}
        </RadioGroup>

        {reason === "otro" ? (
          <TextField value={other} onChange={setOther} maxLength={200} className={field.root}>
            <Label className={field.label}>Cuéntanos (opcional)</Label>
            <TextArea className={cx(field.input, "h-24 py-2")} />
            <span className="self-end text-xs text-tinta/70" aria-hidden>
              {other.length}/200
            </span>
          </TextField>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-xl border border-alerta/30 bg-alerta/5 p-3 text-sm font-medium text-alerta">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <Btn variant="secondary" size="lg" autoFocus onPress={() => onOpenChange(false)}>
            Mantener mi cita
          </Btn>
          <Btn variant="danger" size="lg" isPending={pending} onPress={cancel}>
            {pending ? "Cancelando…" : "Sí, cancelar mi cita"}
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}

// ─── Reprogramar ─────────────────────────────────────────────────────────────

function RescheduleSheet({
  isOpen,
  onOpenChange,
  token,
  today,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  today: string;
}) {
  return (
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange} wide title="Reprogramar" description="Elige el nuevo día y la hora.">
      {/* Se monta en cada apertura: estado limpio. */}
      {isOpen ? <RescheduleForm token={token} today={today} onDone={() => onOpenChange(false)} /> : null}
    </Sheet>
  );
}

function RescheduleForm({
  token,
  today,
  onDone,
}: {
  token: string;
  today: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState(false);

  async function confirm() {
    if (!date || !slot) return;
    setPending(true);
    setError(null);
    const r = await safeCall(() => rescheduleByToken({ token, date, minute: slot.minute }));
    setPending(false);
    if (r.ok) {
      toast(`Listo, tu cita ahora es el ${r.data.dateLabel} a las ${r.data.timeLabel}.`);
      onDone();
      router.refresh();
      return;
    }
    setError(r.error);
    if (isError(r.error, "slotTaken")) {
      setSlot(null);
      setReloadToken((n) => n + 1);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {error ? (
        <p role="alert" className="rounded-xl border border-alerta/30 bg-alerta/5 p-3 text-sm font-medium text-alerta">
          {error}
        </p>
      ) : null}
      <SlotChooser
        daysKey={token}
        loadDays={() => loadRescheduleDays({ token })}
        loadSlots={(d) => loadRescheduleSlots({ token, date: d })}
        today={today}
        date={date}
        onDateChange={(d) => {
          setDate(d);
          setSlot(null);
        }}
        value={slot?.minute ?? null}
        onChange={(s) => {
          setSlot(s);
          if (s) setError(null);
        }}
        reloadToken={reloadToken}
        noDaysMessage="No hay horarios libres en las próximas dos semanas. Escríbenos y te ayudamos."
      />
      <Btn size="lg" className="w-full" isDisabled={!date || !slot} isPending={pending} onPress={confirm}>
        {pending ? "Cambiando…" : date && slot ? `Cambiar a ${shortWeekdayDay(date)}, ${slot.label}` : "Elige un horario"}
      </Btn>
    </div>
  );
}
