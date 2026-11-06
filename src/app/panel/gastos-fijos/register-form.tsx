"use client";

import { CalendarClock, Landmark, Receipt, Wallet } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Form, Input, Label, TextField } from "react-aria-components";
import { FieldMessage, FormError, useFieldErrors } from "../_manage/controls";
import { callAction, MoneyField, unitsOf } from "../_components/money-field";
import { useReauth } from "../_components/reauth";
import { Btn, field } from "../_components/ui";
import { registerRecurringExpenseAction } from "./actions";
import type { RecurringDueItem } from "./view";

// Registrar el pago de un periodo de un gasto fijo (docs/sprint-8-gastos-controles.md §5): es el
// formulario de gasto normal, prellenado con el monto estimado (editable: los servicios varían) y una
// descripción. La categoría y de dónde sale los fija la plantilla. Lo usan Caja y Gastos fijos.
// Sin clave de idempotencia en el navegador: la del servidor es recurring:<id>:<periodo>, así que
// repetir (doble toque, reintento de red) devuelve el mismo gasto.

/** Por qué no se puede registrar un periodo cuya plantilla tiene la categoría desactivada. */
export const INACTIVE_CATEGORY_REASON = "Categoría desactivada: elige otra en la plantilla";

export function FormActions({ pending, onCancel, children, isDisabled }: { pending: boolean; onCancel: () => void; children: ReactNode; isDisabled?: boolean }) {
  return (
    <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
      <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
        Cancelar
      </Btn>
      <Btn type="submit" isPending={pending} isDisabled={isDisabled}>
        {children}
      </Btn>
    </div>
  );
}

/** Lo que se va a registrar: el gasto fijo, el periodo y de dónde sale. */
export function DueSummary({ item }: { item: RecurringDueItem }) {
  return (
    <dl className="grid grid-cols-2 gap-3 rounded-xl border border-tinta/10 bg-hueso/40 p-4 text-sm">
      <div className="col-span-2">
        <dt className="text-xs text-tinta/70">Gasto fijo</dt>
        <dd className="font-semibold">
          {item.name} · {item.periodLabel}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-tinta/70">Vence</dt>
        <dd className="inline-flex items-center gap-1.5">
          <CalendarClock size={14} aria-hidden /> {item.dueLabel} · {item.statusLabel}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-tinta/70">Sale de</dt>
        <dd className="inline-flex items-center gap-1.5 font-semibold">
          {item.payMode === "cash" ? <Wallet size={14} aria-hidden /> : <Landmark size={14} aria-hidden />}
          {item.payMode === "cash" ? "La caja" : "El banco"}
        </dd>
      </div>
      <div className="col-span-2">
        <dt className="text-xs text-tinta/70">Categoría</dt>
        <dd>{item.categoryName}</dd>
      </div>
    </dl>
  );
}

export function RecurringRegisterForm({
  item,
  cashOk,
  onDone,
  onCancel,
}: {
  item: RecurringDueItem;
  /** Para uno de caja: la caja de hoy está abierta (el servidor lo vuelve a exigir). */
  cashOk: boolean;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const reauth = useReauth({ description: "Un gasto pagado del banco cambia las cuentas sin pasar por la caja." });
  const invalid = useFieldErrors<"amount" | "description">();
  const [amount, setAmount] = useState(item.estimatedUnits);
  const [description, setDescription] = useState(item.defaultDescription);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const cashBlocked = item.payMode === "cash" && !cashOk;
  // El gasto exige la categoría activa (el servidor también): se cambia en la plantilla.
  const blocked = cashBlocked || !item.categoryActive;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    if (
      !invalid.check(form, {
        ...(unitsOf(amount) === 0n ? { amount: "Escribe lo que se pagó." } : {}),
        ...(description.trim().length < 3 ? { description: "Describe el gasto (al menos 3 letras)." } : {}),
      })
    )
      return;
    setPending(true);
    const r = await callAction(() =>
      reauth.run(() =>
        registerRecurringExpenseAction({ recurringId: item.recurringId, period: item.period, amountUnits: amount, description: description.trim() }),
      ),
    );
    setPending(false);
    if (r.ok) return onDone(item.payMode === "cash" ? "Gasto fijo registrado: salió de la caja" : "Gasto fijo registrado: salió del banco");
    setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <DueSummary item={item} />
      <MoneyField
        name="amount"
        label="Valor pagado"
        value={amount}
        onChange={(v) => (setAmount(v), invalid.clear("amount"))}
        error={invalid.errors.amount}
        description={`Estimado: ${item.estimatedLabel}. Cámbialo si se pagó otro valor.`}
        isRequired
      />
      <TextField
        name="description"
        value={description}
        onChange={(v) => (setDescription(v), invalid.clear("description"))}
        isRequired
        isInvalid={!!invalid.errors.description}
        maxLength={200}
        className={field.root}
      >
        <Label className={field.label}>Descripción</Label>
        <Input className={field.input} autoComplete="off" />
        <FieldMessage>{invalid.errors.description}</FieldMessage>
      </TextField>
      {!item.categoryActive ? (
        <p className="flex items-start gap-2 rounded-xl border border-cuero/30 bg-cuero/5 p-3 text-sm">
          <Receipt size={18} className="mt-0.5 shrink-0 text-cuero" aria-hidden />
          <span>{INACTIVE_CATEGORY_REASON}.</span>
        </p>
      ) : cashBlocked ? (
        <p className="flex items-start gap-2 rounded-xl border border-cuero/30 bg-cuero/5 p-3 text-sm">
          <Wallet size={18} className="mt-0.5 shrink-0 text-cuero" aria-hidden />
          <span>Sale del efectivo de la caja: abre la caja de hoy para registrarlo.</span>
        </p>
      ) : null}
      <FormError message={error} />
      <FormActions pending={pending} onCancel={onCancel} isDisabled={blocked}>
        <Receipt size={18} aria-hidden /> Registrar gasto
      </FormActions>
      {reauth.dialog}
    </Form>
  );
}
