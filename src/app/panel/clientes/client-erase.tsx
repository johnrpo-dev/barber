"use client";

import { Search, UserX } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Form, Input, Label, Text, TextField } from "react-aria-components";
import { callAction } from "../_components/money-field";
import { useReauth } from "../_components/reauth";
import { Btn, cx, field, PageHeader, Sheet, useToast } from "../_components/ui";
import { card, FormError } from "../_manage/controls";
import { type ClientErasePreviewView, type ClientOption, eraseClientAction, loadClientErasePreview, loadClientsToErase } from "./actions";

// Suprimir los datos de un cliente a su solicitud: buscarlo, ver qué se borra y qué se conserva, y
// confirmar escribiendo SUPRIMIR. El servidor exige el permiso y la reautenticación.

const CONFIRMATION = "SUPRIMIR";

export function ClientErase() {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientOption[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ClientErasePreviewView | null>(null);

  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (query.trim().length < 2) return setError("Escribe al menos 2 letras o números.");
    setSearching(true);
    const r = await callAction(() => loadClientsToErase(query.trim()));
    setSearching(false);
    if (!r.ok) return setError(r.error);
    setResults(r.data);
  }

  async function select(id: string) {
    setError(null);
    const r = await callAction(() => loadClientErasePreview({ clientId: id }));
    if (!r.ok) return setError(r.error);
    setPreview(r.data);
  }

  return (
    <>
      <PageHeader eyebrow="Datos personales" title="Clientes" />
      <p className="text-sm text-tinta/80">Cuando un cliente pide que borren sus datos, búscalo aquí. Se suprime lo personal; lo contable se conserva como exige la ley.</p>

      <Form onSubmit={search} validationBehavior="aria" className="flex flex-col gap-3 min-[400px]:flex-row min-[400px]:items-end">
        <TextField value={query} onChange={setQuery} maxLength={80} className={cx(field.root, "min-[400px]:flex-1")}>
          <Label className={field.label}>Nombre o celular</Label>
          <Input className={field.input} autoComplete="off" />
        </TextField>
        <Btn type="submit" variant="secondary" size="lg" isPending={searching}>
          <Search size={18} aria-hidden />
          {searching ? "Buscando…" : "Buscar"}
        </Btn>
      </Form>

      <FormError message={error} />

      {results !== null ? (
        results.length === 0 ? (
          <p className="text-sm text-tinta/70">No hay clientes con esa búsqueda.</p>
        ) : (
          <ul className={cx(card, "divide-y divide-tinta/10")}>
            {results.map((c) => (
              <li key={c.id}>
                <Button
                  onPress={() => void select(c.id)}
                  className="flex min-h-14 w-full cursor-pointer flex-col items-start justify-center gap-0.5 px-4 py-2 text-left outline-none data-[hovered]:bg-tinta/5 data-[focus-visible]:outline-3 data-[focus-visible]:-outline-offset-3 data-[focus-visible]:outline-cuero"
                >
                  <span className="font-semibold text-tinta">{c.name}</span>
                  {c.phone ? <span className="text-sm text-tinta/70">{c.phone}</span> : null}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <Sheet isOpen={preview !== null} onOpenChange={(open) => !open && setPreview(null)} title="Suprimir datos del cliente" description={preview?.name}>
        {preview ? (
          <EraseForm
            key={preview.id}
            preview={preview}
            onCancel={() => setPreview(null)}
            onDone={() => {
              setPreview(null);
              setResults((rows) => rows?.filter((r) => r.id !== preview.id) ?? null);
              toast("Datos del cliente suprimidos");
            }}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function EraseForm({ preview, onCancel, onDone }: { preview: ClientErasePreviewView; onCancel: () => void; onDone: () => void }) {
  const reauth = useReauth({ description: "Suprimir los datos de un cliente no se puede deshacer." });
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const blocked = preview.activeAppointments > 0;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (confirmation.trim() !== CONFIRMATION) return setError(`Escribe ${CONFIRMATION} para confirmar.`);
    setPending(true);
    const r = await callAction(() => reauth.run(() => eraseClientAction({ clientId: preview.id, confirmation: CONFIRMATION })));
    setPending(false);
    if (!r.ok) return setError(r.error);
    onDone();
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4 text-sm text-tinta/80">
      <p className="font-semibold text-alerta">Esto no se puede deshacer. No se puede recuperar el nombre ni el contacto de esta persona.</p>

      <div className="flex flex-col gap-1">
        <p className="font-semibold text-tinta">Se borra</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Su nombre{preview.phone ? `, su celular (${preview.phone})` : ""}
            {preview.email ? `, su correo (${preview.email})` : ""}.
          </li>
          <li>Las notas de sus {preview.appointments} citas y los motivos de cancelación.</li>
          <li>El contenido de sus avisos y los enlaces para gestionar citas.</li>
          <li>La IP y el navegador con que aceptó la política.</li>
          <li>Los motivos escritos al anular sus ventas.</li>
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <p className="font-semibold text-tinta">Se conserva, porque la ley lo exige</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Sus {preview.sales} ventas y los asientos contables, a nombre de “Anónimo”. Los soportes contables se guardan 10 años.</li>
          <li>Qué autorizó y cuándo, como prueba del consentimiento.</li>
        </ul>
      </div>

      {blocked ? (
        <p className={cx(card, "p-3 font-semibold text-alerta")}>
          Tiene {preview.activeAppointments === 1 ? "una cita activa" : `${preview.activeAppointments} citas activas`}. Cancélala o termínala primero; luego vuelve aquí.
        </p>
      ) : (
        <TextField value={confirmation} onChange={setConfirmation} isRequired className={field.root}>
          <Label className={field.label}>Escribe {CONFIRMATION} para confirmar</Label>
          <Input className={field.input} autoComplete="off" autoCapitalize="characters" />
          <Text slot="description" className={field.description}>
            Hazlo solo si la persona lo pidió. La acción queda en la bitácora, sin sus datos.
          </Text>
        </TextField>
      )}

      <FormError message={error} />

      <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
          Cancelar
        </Btn>
        {blocked ? null : (
          <Btn type="submit" variant="danger" isPending={pending}>
            <UserX size={18} aria-hidden />
            {pending ? "Suprimiendo…" : "Suprimir datos"}
          </Btn>
        )}
      </div>
      {reauth.dialog}
    </Form>
  );
}
