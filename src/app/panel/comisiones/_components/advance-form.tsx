"use client";

import { Banknote, Landmark, LockOpen } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { Form, Label, Radio, RadioGroup, Text, TextArea, TextField } from "react-aria-components";
import { callAction, MoneyField, newKey } from "../../_components/money-field";
import { useReauth } from "../../_components/reauth";
import { SelectField } from "../../_components/select-field";
import { Btn, cx, field, useToast } from "../../_components/ui";
import { FieldMessage, FormError, RadioDot, radioCard, useFieldErrors } from "../../_manage/controls";
import { giveAdvanceAction } from "../actions";

// Anticipo a un barbero (docs/sprint-5-comisiones-informes.md §1 y §3.2): sale de la caja o del
// banco y queda como cuenta por cobrar que se descuenta en la próxima liquidación. Siempre pide
// reautenticación (lo decide el servidor). Al terminar abre el comprobante para firmarlo.

type Field = "staffId" | "amount" | "reason";

export function AdvanceForm({
  staff,
  fixedStaff,
  cashSessionOpen,
  onCancel,
}: {
  /** Personas para elegir (desde la lista de comisiones). */
  staff?: { id: string; name: string }[];
  /** Persona ya elegida (desde la pantalla de una persona). */
  fixedStaff?: { id: string; name: string };
  /** null: no se sabe (el servidor responde si la caja está cerrada). */
  cashSessionOpen: boolean | null;
  onCancel: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const reauth = useReauth({ description: "Un anticipo saca dinero de la caja o de la cuenta del negocio." });
  const invalid = useFieldErrors<Field>();
  const key = useRef(newKey());
  const [staffId, setStaffId] = useState<string | null>(fixedStaff?.id ?? null);
  const [amount, setAmount] = useState("");
  const [paidFrom, setPaidFrom] = useState<"cash" | "bank">(cashSessionOpen === false ? "bank" : "cash");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const found: Partial<Record<Field, string>> = {};
    if (!staffId) found.staffId = "Elige a quién le das el anticipo.";
    if (!/^[1-9]\d*$/.test(amount)) found.amount = "Escribe el valor del anticipo.";
    if (reason.trim().length < 3) found.reason = "Escribe el motivo del anticipo (mínimo 3 letras).";
    if (!invalid.check(e.currentTarget, found) || !staffId) return;
    setPending(true);
    const r = await callAction(() =>
      reauth.run(() =>
        giveAdvanceAction({ staffId, amountUnits: amount, paidFrom, reason: reason.trim(), idempotencyKey: key.current }),
      ),
    );
    setPending(false);
    if (!("network" in r && r.network)) key.current = newKey();
    if (!r.ok) return setError(r.error);
    toast(`Anticipo ${r.data.numberLabel} registrado`);
    router.push(r.data.receiptHref);
  }

  const name = fixedStaff?.name ?? staff?.find((s) => s.id === staffId)?.name;

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-5">
      {fixedStaff ? null : (
        <SelectField
          name="staffId"
          label="Para"
          options={(staff ?? []).map((s) => ({ id: s.id, label: s.name }))}
          value={staffId}
          onChange={(id) => {
            setStaffId(id);
            invalid.clear("staffId");
          }}
          placeholder="Elige a la persona"
          error={invalid.errors.staffId}
          isRequired
        />
      )}

      <MoneyField
        name="amount"
        label="Valor"
        value={amount}
        onChange={(v) => {
          setAmount(v);
          invalid.clear("amount");
        }}
        error={invalid.errors.amount}
        description="En pesos enteros. Se le descuenta en la próxima liquidación."
        isRequired
        size="lg"
        autoFocus={!!fixedStaff}
      />

      <RadioGroup value={paidFrom} onChange={(v) => setPaidFrom(v as "cash" | "bank")} className={field.root}>
        <Label className={field.label}>Sale de</Label>
        <div className="grid grid-cols-2 gap-2">
          <Radio value="cash" isDisabled={cashSessionOpen === false} className={cx(radioCard, "group data-[disabled]:cursor-default data-[disabled]:opacity-50")}>
            <RadioDot />
            <Banknote size={18} aria-hidden className="shrink-0 text-tinta/70" />
            La caja
          </Radio>
          <Radio value="bank" className={cx(radioCard, "group")}>
            <RadioDot />
            <Landmark size={18} aria-hidden className="shrink-0 text-tinta/70" />
            El banco
          </Radio>
        </div>
        <Text slot="description" className={field.description}>
          {cashSessionOpen === false
            ? "La caja está cerrada: ábrela para darlo en efectivo."
            : paidFrom === "bank"
              ? "Sale de la cuenta del negocio. Se pide confirmar tu identidad."
              : "Sale efectivo del turno abierto. Se pide confirmar tu identidad."}
        </Text>
      </RadioGroup>

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
        className={field.root}
      >
        <Label className={field.label}>Motivo</Label>
        <TextArea className={cx(field.input, "h-20 py-2")} placeholder="Ej.: adelanto de la quincena" />
        <Text slot="description" className={field.description}>
          Sale impreso en el comprobante.
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
        <Btn type="submit" isPending={pending}>
          {pending ? "Registrando…" : name ? `Dar anticipo a ${name}` : "Dar anticipo"}
        </Btn>
      </div>
      {reauth.dialog}
    </Form>
  );
}
