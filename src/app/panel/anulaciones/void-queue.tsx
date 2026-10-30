"use client";

import { Check, CheckCircle2, Clock, LockOpen, ReceiptText, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useRef, useState } from "react";
import { Form, Label, TextArea, TextField, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { card, Chip, FieldMessage, FormError, useFieldErrors } from "../_manage/controls";
import { callAction, newKey } from "../_components/money-field";
import { useReauth } from "../_components/reauth";
import { Btn, cx, field, PageHeader, Sheet, useToast } from "../_components/ui";
import { decideVoidAction, loadVoidQueue } from "./actions";

// Anulaciones (docs/sprint-4-cobro-caja.md §7): el dueño ve la cola con la venta completa, quién
// cobró y el motivo, y aprueba o rechaza con reautenticación; recepción ve sus solicitudes.

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
type Queue = OkData<Awaited<ReturnType<typeof loadVoidQueue>>>;
type VoidRequest = Queue["requests"][number];

const STATUS = {
  pending: { label: "Pendiente", tone: "primary", icon: Clock },
  approved: { label: "Anulada", tone: "muted", icon: CheckCircle2 },
  rejected: { label: "Rechazada", tone: "neutral", icon: X },
} as const;

export function VoidQueue({ initial, canDecide }: { initial: Queue; canDecide: boolean }) {
  const toast = useToast();
  const [requests, setRequests] = useState(initial.requests);
  const [tab, setTab] = useState<"pending" | "done">("pending");
  const [deciding, setDeciding] = useState<{ request: VoidRequest; approve: boolean } | null>(null);
  /** Aviso del servidor al aprobar (propina ya pagada, efectivo devuelto con la caja cerrada…). */
  const [warning, setWarning] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await callAction(() => loadVoidQueue());
    if (r.ok) setRequests(r.data.requests);
    else toast(r.error, "error");
  }, [toast]);

  const pending = requests.filter((r) => r.status === "pending");
  const done = requests.filter((r) => r.status !== "pending");
  const shown = canDecide ? (tab === "pending" ? pending : done) : requests;

  return (
    <>
      <PageHeader eyebrow={canDecide ? "Aprobación del dueño" : "Tus solicitudes"} title="Anulaciones" />

      {canDecide ? (
        <ToggleButtonGroup
          aria-label="Ver"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[tab]}
          onSelectionChange={(keys) => {
            const k = [...keys][0];
            if (k !== undefined) setTab(k as "pending" | "done");
          }}
          className="grid grid-cols-2 gap-2 rounded-xl bg-tinta/5 p-1"
        >
          {(
            [
              ["pending", `Pendientes (${pending.length})`],
              ["done", `Resueltas (${done.length})`],
            ] as const
          ).map(([id, label]) => (
            <ToggleButton
              key={id}
              id={id}
              className={({ isSelected, isFocusVisible }) =>
                cx(
                  "monto h-11 rounded-lg text-sm font-semibold transition-colors",
                  isSelected ? "bg-papel text-tinta shadow-sm" : "text-tinta/70",
                  isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
                )
              }
            >
              {label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      ) : (
        <p className="text-sm text-tinta/70">Las solicitudes las pides desde Caja, en las ventas del día. El dueño las aprueba o las rechaza.</p>
      )}

      <div role="alert">
        {warning ? (
          <div className="flex items-start gap-3 rounded-xl border border-alerta/30 bg-alerta/5 p-4">
            <TriangleAlert size={20} className="mt-0.5 shrink-0 text-alerta" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <p className="font-semibold text-alerta">Atención</p>
              <p className="text-tinta/80">{warning}</p>
            </div>
            <Btn variant="ghost" size="sm" className="h-11 w-11 shrink-0 px-0" aria-label="Cerrar aviso" onPress={() => setWarning(null)}>
              <X size={16} aria-hidden />
            </Btn>
          </div>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-tinta/20 bg-papel px-6 py-12 text-center">
          <ReceiptText size={32} className="text-tinta/40" aria-hidden />
          <p className="mt-3 font-display text-2xl">{canDecide && tab === "pending" ? "Nada por revisar" : "Sin solicitudes"}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((r) => (
            <li key={r.id}>
              <RequestCard request={r} canDecide={canDecide} onDecide={(approve) => setDeciding({ request: r, approve })} />
            </li>
          ))}
        </ul>
      )}

      <Sheet
        isOpen={deciding !== null}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={deciding?.approve ? "Aprobar anulación" : "Rechazar anulación"}
        description={deciding ? `Venta de ${deciding.request.totalLabel}` : undefined}
      >
        {deciding ? (
          <DecideForm
            key={`${deciding.request.id}-${deciding.approve}`}
            request={deciding.request}
            approve={deciding.approve}
            onCancel={() => setDeciding(null)}
            onDone={(message, notice) => {
              setDeciding(null);
              toast(message);
              setWarning(notice);
              void refresh();
            }}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function RequestCard({ request: r, canDecide, onDecide }: { request: VoidRequest; canDecide: boolean; onDecide: (approve: boolean) => void }) {
  const st = STATUS[r.status];
  const Icon = st.icon;
  return (
    <article className={cx(card, "flex flex-col gap-3 p-4")} aria-label={`Solicitud por ${r.totalLabel}, ${st.label}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="monto text-2xl font-semibold">{r.totalLabel}</span>
          <span className="text-xs text-tinta/70">
            <span className="monto">{r.atLabel}</span>
          </span>
        </div>
        <Chip tone={st.tone} icon={<Icon size={12} aria-hidden />}>
          {st.label}
        </Chip>
      </div>
      {r.lines.length > 0 ? (
        <ul className="flex flex-col gap-0.5 rounded-lg bg-hueso/50 px-3 py-2 text-sm">
          {r.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : null}
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-tinta/70">Cobró</dt>
          <dd className="font-semibold">{r.chargedBy}</dd>
        </div>
        <div>
          <dt className="text-xs text-tinta/70">Pidió</dt>
          <dd className="font-semibold">{r.requestedBy}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-tinta/70">Motivo</dt>
          <dd>{r.reason}</dd>
        </div>
      </dl>
      {canDecide && r.status === "pending" ? (
        <div className="grid grid-cols-2 gap-2 border-t border-tinta/10 pt-3">
          <Btn variant="secondary" onPress={() => onDecide(false)}>
            <X size={18} aria-hidden /> Rechazar
          </Btn>
          <Btn variant="danger" onPress={() => onDecide(true)}>
            <Check size={18} aria-hidden /> Aprobar
          </Btn>
        </div>
      ) : null}
    </article>
  );
}

function DecideForm({
  request,
  approve,
  onCancel,
  onDone,
}: {
  request: VoidRequest;
  approve: boolean;
  onCancel: () => void;
  onDone: (message: string, warning: string | null) => void;
}) {
  const reauth = useReauth({ description: "Anular una venta cambia las cuentas." });
  const invalid = useFieldErrors<"note">();
  const key = useRef(newKey());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!approve && !invalid.check(e.currentTarget, note.trim().length < 3 ? { note: "Explica por qué la rechazas." } : {})) return;
    setPending(true);
    const r = await callAction(() =>
      reauth.run(() => decideVoidAction({ requestId: request.id, approve, note: note.trim(), idempotencyKey: key.current })),
    );
    setPending(false);
    if (!("network" in r && r.network)) key.current = newKey();
    if (r.ok) return onDone(r.data.status === "approved" ? "Venta anulada: se registró el asiento de reversa" : "Solicitud rechazada", r.data.warning);
    setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      {approve ? (
        <p className="text-sm text-tinta/80">
          Se registra un asiento de reversa de la venta: se deshacen el ingreso, la comisión y la propina por pagar. Si la propina ya se pagó en efectivo, ese pago no se devuelve.
        </p>
      ) : (
        <p className="text-sm text-tinta/80">La venta queda como está y quien la pidió ve el rechazo con tu nota.</p>
      )}
      <TextField name="note" value={note} onChange={(v) => (setNote(v), invalid.clear("note"))} isRequired={!approve} isInvalid={!!invalid.errors.note} maxLength={300} className={field.root}>
        <Label className={field.label}>{approve ? "Nota (opcional)" : "Nota"}</Label>
        <TextArea className={cx(field.input, "h-20 py-2")} />
        <FieldMessage>{invalid.errors.note}</FieldMessage>
      </TextField>
      <FormError message={error} />
      {error && needsOpenDrawer(error) ? (
        // C1: el efectivo de la venta se devuelve desde un turno abierto. Se explica y se lleva a la caja.
        <div className="flex flex-col gap-2 rounded-xl border border-tinta/15 bg-hueso/60 p-3 text-sm">
          <p className="text-tinta/80">
            Esta venta tuvo efectivo y la devolución sale de la caja del turno. Abre la caja (contando la base) y vuelve a aprobar la anulación.
          </p>
          <Link
            href="/panel/caja"
            className="inline-flex h-11 items-center gap-2 self-start rounded-lg border border-tinta/20 px-4 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-tinta"
          >
            <LockOpen size={18} aria-hidden /> Ir a la caja
          </Link>
        </div>
      ) : null}
      <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" variant={approve ? "danger" : "primary"} isPending={pending}>
          {approve ? "Sí, anular la venta" : "Rechazar solicitud"}
        </Btn>
      </div>
      {reauth.dialog}
    </Form>
  );
}

/** El error de anular una venta en efectivo con la caja cerrada (C1, src/db/voids.ts). */
const needsOpenDrawer = (message: string) => message.startsWith("Abre la caja");
