"use client";

import { ArrowLeft, BadgeCheck, LockOpen, MonitorSmartphone, Search, ShieldOff, UserX } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Button, Dialog, Form, Heading, Input, Label, Modal, ModalOverlay, TextField } from "react-aria-components";
import { StatusBadge } from "../agenda/_components/status";
import { callAction } from "../_components/money-field";
import { Btn, cx, field, PageHeader, useToast } from "../_components/ui";
import { card, FormError } from "../_manage/controls";
import {
  type ClientSearchView,
  clearClientNoShowsAction,
  forgetClientDevicesAction,
  loadClientRecord,
  loadClientSearch,
  withdrawConsentAction,
} from "./actions";
import { EraseClientButton } from "./client-erase";
import type { ClientRecordView, ConsentView } from "./record-view";

// Ficha del cliente (sprint 7): buscarlo y ver su historial, sus faltas, sus autorizaciones y sus
// navegadores recordados. Recepción y el dueño retiran el recordatorio o las promociones (a pedido
// de la persona), olvidan los navegadores y desbloquean la reserva en línea; el dueño, además,
// suprime los datos. Retirar y olvidar piden confirmación. El servidor vuelve a exigir cada permiso.

type Pending = { kind: "withdraw"; consent: ConsentView } | { kind: "forget" };

export function ClientRecordScreen({ canErase }: { canErase: boolean }) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientSearchView | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<ClientRecordView | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (query.trim().length < 2) return setError("Escribe al menos 2 letras o números.");
    setSearching(true);
    const r = await callAction(() => loadClientSearch(query.trim()));
    if (!r.ok) {
      setSearching(false);
      return setError(r.error);
    }
    setRecord(null);
    setResults(r.data);
    // Un solo resultado: se abre su ficha de una vez.
    if (r.data.clients.length === 1) await open(r.data.clients[0]!.id);
    setSearching(false);
  }

  async function open(id: string) {
    setError(null);
    setOpening(id);
    const r = await callAction(() => loadClientRecord({ clientId: id }));
    setOpening(null);
    if (!r.ok) return setError(r.error);
    setRecord(r.data);
  }

  function searchAgain() {
    setRecord(null);
    setResults(null);
    setQuery("");
    setError(null);
    searchInput.current?.focus();
  }

  async function reload(id: string) {
    const r = await callAction(() => loadClientRecord({ clientId: id }));
    if (r.ok) setRecord(r.data);
    else toast(r.error, "error");
  }

  return (
    <>
      <PageHeader eyebrow="Ficha y datos personales" title="Clientes" />
      <p className="text-sm text-tinta/80">Busca a un cliente para ver sus citas, sus faltas y lo que autorizó.</p>

      <Form onSubmit={search} validationBehavior="aria" className="flex flex-col gap-3 min-[400px]:flex-row min-[400px]:items-end">
        <TextField value={query} onChange={setQuery} maxLength={80} className={cx(field.root, "min-[400px]:flex-1")}>
          <Label className={field.label}>Nombre o celular</Label>
          <Input ref={searchInput} className={field.input} autoComplete="off" />
        </TextField>
        <Btn type="submit" variant="secondary" size="lg" isPending={searching}>
          <Search size={18} aria-hidden />
          {searching ? "Buscando…" : "Buscar"}
        </Btn>
      </Form>

      <FormError message={error} />

      {record ? (
        <>
          {results && results.clients.length > 1 ? (
            <Btn variant="ghost" className="-ml-2 self-start" onPress={() => setRecord(null)}>
              <ArrowLeft size={18} aria-hidden /> Volver a los resultados
            </Btn>
          ) : (
            <Btn variant="ghost" className="-ml-2 self-start" onPress={searchAgain}>
              <Search size={18} aria-hidden /> Buscar otro cliente
            </Btn>
          )}
          <Record
            key={record.id}
            record={record}
            canErase={canErase}
            onChanged={() => void reload(record.id)}
            onErased={() => {
              setResults((found) => (found ? { ...found, clients: found.clients.filter((c) => c.id !== record.id) } : null));
              setRecord(null);
            }}
          />
        </>
      ) : results !== null ? (
        results.clients.length === 0 ? (
          <p className="text-sm text-tinta/70">No hay clientes con esa búsqueda.</p>
        ) : (
          <>
            <ul className={cx(card, "divide-y divide-tinta/10")}>
              {results.clients.map((c) => (
                <li key={c.id}>
                  <Button
                    onPress={() => void open(c.id)}
                    isPending={opening === c.id}
                    className="flex min-h-14 w-full cursor-pointer flex-col items-start justify-center gap-0.5 px-4 py-2 text-left outline-none data-[hovered]:bg-tinta/5 data-[pending]:opacity-70 data-[focus-visible]:outline-3 data-[focus-visible]:-outline-offset-3 data-[focus-visible]:outline-cuero"
                  >
                    <span className="font-semibold text-tinta">{c.name}</span>
                    {c.phone ? <span className="monto text-sm text-tinta/70">{c.phone}</span> : null}
                  </Button>
                </li>
              ))}
            </ul>
            {results.hasMore ? <p className="text-sm text-tinta/80">Hay más resultados: afina la búsqueda.</p> : null}
          </>
        )
      ) : null}
    </>
  );
}

function Record({ record: r, canErase, onChanged, onErased }: { record: ClientRecordView; canErase: boolean; onChanged: () => void; onErased: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [pending, setPending] = useState(false);
  const [unblocking, setUnblocking] = useState(false);

  async function unblock() {
    setUnblocking(true);
    const res = await callAction(() => clearClientNoShowsAction({ clientId: r.id }));
    setUnblocking(false);
    toast(res.ok ? "Reserva en línea desbloqueada" : res.error, res.ok ? undefined : "error");
    if (res.ok) onChanged();
  }

  async function run() {
    if (!confirm) return;
    setPending(true);
    const res =
      confirm.kind === "withdraw"
        ? await callAction(() => withdrawConsentAction({ clientId: r.id, purpose: confirm.consent.purpose as "reminders" | "marketing" }))
        : await callAction(() => forgetClientDevicesAction({ clientId: r.id }));
    setPending(false);
    setConfirm(null);
    if (!res.ok) return toast(res.error, "error");
    toast(confirm.kind === "withdraw" ? `${confirm.consent.label}: autorización retirada` : "Navegadores olvidados");
    onChanged();
  }

  return (
    <article className="flex flex-col gap-4" aria-label={`Ficha de ${r.name}`}>
      <section className={cx(card, "flex flex-col gap-2 p-4")}>
        <h2 className="font-display text-2xl leading-tight">{r.name}</h2>
        <dl className="flex flex-col gap-1 text-sm">
          {r.phone ? (
            <div className="flex flex-wrap items-center gap-x-2">
              <dt className="sr-only">Celular</dt>
              <dd className="monto font-semibold">{r.phone}</dd>
              <dd className={cx("inline-flex items-center gap-1 text-xs font-semibold", r.verified ? "text-botella" : "text-tinta/70")}>
                {r.verified ? <BadgeCheck size={14} aria-hidden /> : null}
                {r.verified ? "Celular verificado" : "Celular sin verificar"}
              </dd>
            </div>
          ) : (
            <div>
              <dt className="sr-only">Celular</dt>
              <dd className="text-tinta/70">Sin celular</dd>
            </div>
          )}
          {r.email ? (
            <div>
              <dt className="sr-only">Correo</dt>
              <dd>{r.email}</dd>
            </div>
          ) : null}
          <div>
            <dt className="sr-only">Cliente desde</dt>
            <dd className="text-tinta/70">Cliente desde el {r.sinceLabel}</dd>
          </div>
        </dl>
      </section>

      <section className={cx(card, "flex flex-col gap-3 p-4")} aria-labelledby="ficha-faltas">
        <h3 id="ficha-faltas" className="text-sm font-semibold">
          Faltas
        </h3>
        {r.noShows.notice ? (
          <p className={cx("flex items-center gap-2 text-sm font-semibold", r.noShows.suspended ? "text-alerta" : "text-tinta")}>
            <UserX size={16} aria-hidden /> {r.noShows.notice}
          </p>
        ) : (
          <p className="text-sm text-tinta/80">Sin faltas que cuenten hoy. Puede reservar en línea.</p>
        )}
        {r.noShows.suspended ? (
          <>
            <p className="text-xs text-tinta/80">Desde el panel se le puede agendar igual. Desbloquéalo si el cliente se compromete a avisar cuando no pueda venir.</p>
            <Btn variant="secondary" className="self-start" isPending={unblocking} onPress={() => void unblock()}>
              <LockOpen size={16} aria-hidden /> Desbloquear reserva en línea
            </Btn>
          </>
        ) : null}
      </section>

      <section className={cx(card, "flex flex-col gap-3 p-4")} aria-labelledby="ficha-historial">
        <h3 id="ficha-historial" className="text-sm font-semibold">
          Historial
        </h3>
        <dl className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-3 sm:grid-cols-5">
          {(
            [
              ["Citas", r.counts.total],
              ["Próximas", r.counts.upcoming],
              ["Terminadas", r.counts.completed],
              ["No vino", r.counts.noShows],
              ["Canceladas", r.counts.cancelled],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="rounded-lg bg-tinta/[0.04] px-3 py-2">
              <dt className="text-xs text-tinta/70">{label}</dt>
              <dd className="monto text-lg font-semibold">{n}</dd>
            </div>
          ))}
        </dl>
        {r.history.length === 0 ? (
          <p className="text-sm text-tinta/70">Todavía no tiene citas.</p>
        ) : (
          <>
            <ol className="divide-y divide-tinta/10">
              {r.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      <span className="monto">{h.dateLabel}</span> · <span className="monto">{h.timeLabel}</span>
                    </p>
                    <p className="text-sm text-tinta/80">
                      {h.serviceName} · {h.staffName}
                    </p>
                  </div>
                  <StatusBadge status={h.status} />
                </li>
              ))}
            </ol>
            {r.counts.total > r.history.length ? <p className="text-xs text-tinta/70">Se muestran las últimas {r.historyLimit} citas.</p> : null}
          </>
        )}
      </section>

      <section className={cx(card, "flex flex-col gap-3 p-4")} aria-labelledby="ficha-autorizaciones">
        <h3 id="ficha-autorizaciones" className="text-sm font-semibold">
          Autorizaciones
        </h3>
        <ul className="divide-y divide-tinta/10">
          {r.consents.map((c) => (
            <li key={c.purpose} className="flex flex-col gap-2 py-2 min-[400px]:flex-row min-[400px]:items-center min-[400px]:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {c.label}: <span className={c.granted ? "text-botella" : "text-tinta/70"}>{consentStatus(c)}</span>
                </p>
                {c.version ? (
                  <p className="text-xs text-tinta/70">
                    Política <span className="monto">{c.version}</span> · {c.dateLabel} · {c.bySource}
                  </p>
                ) : null}
              </div>
              {c.withdrawable ? (
                <Btn variant="secondary" className="self-start" onPress={() => setConfirm({ kind: "withdraw", consent: c })}>
                  <ShieldOff size={16} aria-hidden /> Retirar
                </Btn>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="text-xs text-tinta/70">
          Retira el recordatorio o las promociones solo si la persona lo pide. El tratamiento de datos no se retira aquí: si lo pide, es una supresión de datos.
        </p>
      </section>

      <section className={cx(card, "flex flex-col gap-3 p-4")} aria-labelledby="ficha-navegadores">
        <h3 id="ficha-navegadores" className="text-sm font-semibold">
          Navegadores recordados
        </h3>
        <p className="flex items-center gap-2 text-sm">
          <MonitorSmartphone size={16} aria-hidden />
          {r.devices.active === 0
            ? "Ninguno: la próxima reserva en línea confirma el celular de nuevo."
            : `${r.devices.active === 1 ? "1 navegador reserva" : `${r.devices.active} navegadores reservan`} sin confirmar el celular. Último uso: ${r.devices.lastUsedLabel}.`}
        </p>
        {r.devices.active > 0 ? (
          <Btn variant="secondary" className="self-start" onPress={() => setConfirm({ kind: "forget" })}>
            Olvidar los navegadores
          </Btn>
        ) : null}
      </section>

      {canErase ? (
        <section className={cx(card, "flex flex-col gap-3 p-4")} aria-labelledby="ficha-supresion">
          <h3 id="ficha-supresion" className="text-sm font-semibold">
            Supresión de datos
          </h3>
          <p className="text-sm text-tinta/80">Si la persona pide que borren sus datos: se suprime lo personal; lo contable se conserva como exige la ley.</p>
          <EraseClientButton clientId={r.id} onErased={onErased} />
        </section>
      ) : null}

      <ConfirmChange pending={pending} confirm={confirm} name={r.name} onCancel={() => setConfirm(null)} onConfirm={() => void run()} />
    </article>
  );
}

function consentStatus(c: ConsentView): string {
  if (c.granted) return "vigente";
  if (c.version === null) return "nunca la dio";
  return c.bySource === "En la barbería" ? "retirada" : "no autorizada";
}

function ConfirmChange({
  confirm,
  name,
  pending,
  onCancel,
  onConfirm,
}: {
  confirm: Pending | null;
  name: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Al cerrar, confirm pasa a null mientras el diálogo se desvanece: se sigue mostrando el último
  // para que el texto no cambie en la salida.
  const [last, setLast] = useState<Pending | null>(confirm);
  if (confirm !== null && confirm !== last) setLast(confirm);
  const shown = confirm ?? last;
  const title = shown?.kind === "withdraw" ? `¿Retirar «${shown.consent.label}»?` : "¿Olvidar sus navegadores?";
  const detail =
    shown?.kind === "withdraw"
      ? shown.consent.purpose === "reminders"
        ? `${name} deja de recibir el recordatorio el día de la cita. Queda registrado en la bitácora.`
        : `${name} deja de recibir promociones. Queda registrado en la bitácora.`
      : `La próxima vez que ${name} reserve en línea tendrá que confirmar su celular otra vez. Queda registrado en la bitácora.`;
  return (
    <ModalOverlay
      isOpen={confirm !== null}
      onOpenChange={(open) => !open && onCancel()}
      isDismissable={!pending}
      className="fixed inset-0 z-[55] grid place-items-center bg-tinta/40 p-4 data-[entering]:animate-fade-in"
    >
      <Modal className="w-full max-w-sm rounded-2xl bg-papel p-5 shadow-2xl data-[entering]:animate-pop-in">
        <Dialog role="alertdialog" aria-describedby="ficha-confirmar-detalle" className="flex flex-col gap-4 outline-none">
          <Heading slot="title" className="font-display text-2xl leading-tight">
            {title}
          </Heading>
          <p id="ficha-confirmar-detalle" className="text-sm text-tinta/80">
            {detail}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Btn variant="ghost" onPress={onCancel} isDisabled={pending} autoFocus>
              Volver
            </Btn>
            <Btn variant="danger" isPending={pending} onPress={onConfirm}>
              {shown?.kind === "withdraw" ? "Sí, retirar" : "Sí, olvidarlos"}
            </Btn>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
