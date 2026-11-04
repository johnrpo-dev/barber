"use client";

import { LockOpen, Undo2 } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useRef, useState } from "react";
import { Form, Label, Text, TextArea, TextField } from "react-aria-components";
import { callAction, newKey } from "../../_components/money-field";
import { useReauth } from "../../_components/reauth";
import { Btn, cx, field } from "../../_components/ui";
import { FieldMessage, FormError, useFieldErrors } from "../../_manage/controls";
import { reverseAdvanceAction, reverseSettlementAction } from "../actions";

// Revertir una liquidación (solo la última vigente de la persona) o un anticipo que todavía no se
// descontó (docs/sprint-5-comisiones-informes.md §3.3). Siempre con motivo y reautenticación; se
// registra en el día contable de hoy. El servidor decide si se puede; aquí solo se explica.

export function ReverseForm({
  kind,
  publicId,
  numberLabel,
  amountLabel,
  paidFromLabel,
  onCancel,
  onDone,
}: {
  kind: "settlement" | "advance";
  publicId: string;
  numberLabel: string;
  amountLabel: string;
  /** De dónde salió el dinero ("Caja", "Banco"); null si no hubo pago. */
  paidFromLabel: string | null;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const reauth = useReauth({ description: "Revertir un pago al personal cambia las cuentas." });
  const invalid = useFieldErrors<"reason">();
  const key = useRef(newKey());
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const what = kind === "settlement" ? "liquidación" : "anticipo";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!invalid.check(e.currentTarget, reason.trim().length < 3 ? { reason: "Escribe el motivo de la reversa (mínimo 3 letras)." } : {})) return;
    setPending(true);
    const input = { publicId, reason: reason.trim(), idempotencyKey: key.current };
    const r = await callAction(() => reauth.run(() => (kind === "settlement" ? reverseSettlementAction(input) : reverseAdvanceAction(input))));
    setPending(false);
    if (!("network" in r && r.network)) key.current = newKey();
    if (!r.ok) return setError(r.error);
    onDone(kind === "settlement" ? `Liquidación ${numberLabel} revertida` : `Anticipo ${numberLabel} revertido`);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 text-sm text-tinta/80">
        {kind === "settlement" ? (
          <p>
            Se registra un asiento de reversa con fecha de hoy. Las comisiones, propinas y anticipos de esta liquidación vuelven a quedar pendientes y el comprobante queda
            marcado como revertido.
          </p>
        ) : (
          <p>Se registra un asiento de reversa con fecha de hoy y el anticipo deja de descontarse. El comprobante queda marcado como revertido.</p>
        )}
        {paidFromLabel ? (
          <p className="font-semibold text-tinta">
            Se pagó desde: {paidFromLabel}. La persona devuelve <span className="monto">{amountLabel}</span> por el mismo medio; si fue de la caja, entra al turno
            abierto (ábrelo antes).
          </p>
        ) : (
          <p>Esta liquidación no movió dinero: solo se deshace el registro.</p>
        )}
      </div>

      <TextField
        name="reason"
        value={reason}
        onChange={(v) => {
          setReason(v);
          invalid.clear("reason");
        }}
        isRequired
        isInvalid={!!invalid.errors.reason}
        maxLength={300}
        autoFocus
        className={field.root}
      >
        <Label className={field.label}>Motivo</Label>
        <TextArea className={cx(field.input, "h-20 py-2")} />
        <Text slot="description" className={field.description}>
          Queda en el comprobante y en la bitácora.
        </Text>
        <FieldMessage>{invalid.errors.reason}</FieldMessage>
      </TextField>

      <FormError message={error} />
      {error?.startsWith("Abre la caja") ? (
        <Link
          href="/panel/caja"
          className="inline-flex h-11 items-center gap-2 self-start rounded-lg border border-tinta/20 px-4 text-sm font-semibold outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cuero"
        >
          <LockOpen size={18} aria-hidden /> Ir a la caja
        </Link>
      ) : null}

      <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" variant="danger" isPending={pending}>
          <Undo2 size={18} aria-hidden />
          {pending ? "Revirtiendo…" : `Revertir ${what} ${numberLabel}`}
        </Btn>
      </div>
      {reauth.dialog}
    </Form>
  );
}
