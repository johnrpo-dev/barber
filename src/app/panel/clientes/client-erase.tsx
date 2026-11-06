"use client";

import { UserX } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Form, Input, Label, Text, TextField } from "react-aria-components";
import { callAction } from "../_components/money-field";
import { useReauth } from "../_components/reauth";
import { Btn, cx, field, Sheet, useToast } from "../_components/ui";
import { card, FormError } from "../_manage/controls";
import { type ClientErasePreviewView, eraseClientAction, loadClientErasePreview } from "./actions";

// Suprimir los datos de un cliente a su solicitud, desde su ficha (sprint 7): ver qué se borra y qué
// se conserva, y confirmar escribiendo SUPRIMIR. El servidor exige el permiso y la reautenticación.

const CONFIRMATION = "SUPRIMIR";

/** Desde la ficha del cliente: abre la misma vista previa y la misma confirmación. Solo el dueño. */
export function EraseClientButton({ clientId, onErased }: { clientId: string; onErased: () => void }) {
  const toast = useToast();
  const [preview, setPreview] = useState<ClientErasePreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function open() {
    setError(null);
    setLoading(true);
    const r = await callAction(() => loadClientErasePreview({ clientId }));
    setLoading(false);
    if (!r.ok) return setError(r.error);
    setPreview(r.data);
  }

  return (
    <div className="flex flex-col gap-2">
      <Btn variant="danger" className="self-start" isPending={loading} onPress={() => void open()}>
        <UserX size={18} aria-hidden />
        Suprimir datos del cliente
      </Btn>
      <FormError message={error} />
      <EraseSheet
        preview={preview}
        onClose={() => setPreview(null)}
        onDone={() => {
          setPreview(null);
          toast("Datos del cliente suprimidos");
          onErased();
        }}
      />
    </div>
  );
}

function EraseSheet({ preview, onClose, onDone }: { preview: ClientErasePreviewView | null; onClose: () => void; onDone: () => void }) {
  return (
    <Sheet isOpen={preview !== null} onOpenChange={(open) => !open && onClose()} title="Suprimir datos del cliente" description={preview?.name}>
      {preview ? <EraseForm key={preview.id} preview={preview} onCancel={onClose} onDone={onDone} /> : null}
    </Sheet>
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
