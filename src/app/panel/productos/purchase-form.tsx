"use client";

import { Landmark, PackagePlus, Plus, Trash2, Wallet } from "lucide-react";
import { type FormEvent, useCallback, useRef, useState } from "react";
import { Form, Input, Label, Radio, RadioGroup, TextField } from "react-aria-components";
import { format, fromUnits, type Money, money, mulDiv, sum } from "@/domain/money";
import type { ActionResult } from "@/lib/action";
import { callAction, MoneyField, newKey, onlyDigits, unitsOf } from "../_components/money-field";
import { useReauth } from "../_components/reauth";
import { SelectField } from "../_components/select-field";
import { Btn, cx, field, SheetFooter } from "../_components/ui";
import { FormError, RadioDot, radioCard } from "../_manage/controls";

// Compra de mercancía con varias líneas (producto, unidades, costo TOTAL de la línea), compartida por
// Caja (de la caja) y Productos (del banco o carga inicial). El total que se ve es solo una vista
// previa con money.ts; el servidor vuelve a sumar y la base exige que el documento cuadre.

export type PurchasePaidFrom = "cash" | "bank" | "owner";

export interface PurchasePayload {
  paidFrom: PurchasePaidFrom;
  lines: { productId: string; quantity: string; amountUnits: string }[];
  note?: string;
  idempotencyKey: string;
}

interface Line {
  key: string;
  productId: string | null;
  quantity: string;
  amount: string;
}

const emptyLine = (): Line => ({ key: newKey(), productId: null, quantity: "1", amount: "" });

export interface PurchaseProduct {
  id: string;
  name: string;
  /** Precio de venta en centavos (texto): si el costo por unidad lo supera, se pide confirmar. */
  priceMinor: string;
}

interface HighCost {
  name: string;
  unitCost: Money;
  price: Money;
}

/**
 * Líneas cuyo costo por unidad supera el precio de venta: casi siempre un error de dedo (un cero de
 * más, o el costo por unidad escrito como total). Una compra registrada no se borra, así que se avisa
 * antes. Solo es un aviso: comprar caro a veces es real (un producto en promoción), y se puede confirmar.
 */
export function highCostLines(lines: readonly Line[], products: readonly PurchaseProduct[]): HighCost[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  return lines.flatMap((l) => {
    const product = l.productId ? byId.get(l.productId) : undefined;
    const quantity = unitsOf(l.quantity);
    if (!product || quantity === 0n || l.amount === "" || !/^\d+$/.test(product.priceMinor)) return [];
    const amount = fromUnits(unitsOf(l.amount));
    const price = money(BigInt(product.priceMinor));
    // Exacto, sin redondeo: costo total > precio × unidades. El costo por unidad es solo para mostrarlo.
    if (amount.minor <= mulDiv(price, quantity, 1n).minor) return [];
    return [{ name: product.name, unitCost: mulDiv(amount, 1n, quantity), price }];
  });
}

/** Clave de idempotencia del formulario: se conserva ante un fallo de red y se renueva tras una respuesta. */
function useKeyedAction() {
  const key = useRef(newKey());
  return useCallback(async <T,>(fn: (idempotencyKey: string) => Promise<ActionResult<T>>) => {
    const r = await callAction(() => fn(key.current));
    if (!("network" in r && r.network)) key.current = newKey();
    return r;
  }, []);
}

const PAID_FROM_OPTIONS: Record<Exclude<PurchasePaidFrom, "cash">, { label: string; hint: string }> = {
  bank: { label: "Banco", hint: "Transferencia o tarjeta del negocio" },
  owner: { label: "Carga inicial", hint: "Mercancía que ya había; la aporta el dueño" },
};

export function PurchaseForm({
  products,
  paidFromOptions,
  submit,
  onDone,
  onCancel,
  isCashShort,
}: {
  products: PurchaseProduct[];
  /** "cash" (Caja) o ["bank", "owner"] (Productos). */
  paidFromOptions: readonly PurchasePaidFrom[];
  submit: (payload: PurchasePayload) => Promise<ActionResult<{ totalLabel: string }>>;
  onDone: (message: string) => void;
  onCancel: () => void;
  /** Para resaltar el total cuando la caja no tiene tanto efectivo. */
  isCashShort?: (message: string) => boolean;
}) {
  const run = useKeyedAction();
  // Una compra del banco o la carga inicial pide confirmar identidad (lo decide el servidor).
  const reauth = useReauth({ description: "Una compra del banco o la carga inicial cambia las cuentas sin pasar por la caja." });
  const [paidFrom, setPaidFrom] = useState<PurchasePaidFrom>(paidFromOptions[0] ?? "cash");
  const [lines, setLines] = useState<Line[]>(() => [emptyLine()]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  const total = sum(lines.map((l) => fromUnits(unitsOf(l.amount))));
  const chosen = new Set(lines.map((l) => l.productId).filter((id): id is string => id !== null));
  const highCost = highCostLines(lines, products);
  // Huella de lo que se advirtió: si cambian las líneas caras, se vuelve a pedir confirmación.
  const highCostSig = highCost.map((h) => `${h.name}:${h.unitCost.minor}`).join("|");
  const [confirmedSig, setConfirmedSig] = useState<string | null>(null);
  const needsConfirm = highCost.length > 0 && confirmedSig !== highCostSig;

  function update(key: string, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setLineErrors((e) => {
      if (!(key in e)) return e;
      const rest = { ...e };
      delete rest[key];
      return rest;
    });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const errors: Record<string, string> = {};
    for (const l of lines) {
      if (!l.productId) errors[l.key] = "Elige el producto.";
      else if (unitsOf(l.quantity) === 0n) errors[l.key] = "Escribe cuántas unidades.";
      else if (l.amount === "") errors[l.key] = "Escribe el costo total de la línea.";
    }
    setLineErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (total.minor <= 0n) return setError("El total de la compra debe ser mayor que cero.");
    if (needsConfirm) {
      // Primer intento con un costo por unidad mayor que el precio de venta: se muestra el aviso y el
      // botón pasa a "Sí, registrar". El segundo intento, con las mismas líneas, registra.
      setConfirmedSig(highCostSig);
      return;
    }
    setPending(true);
    const payload = {
      paidFrom,
      lines: lines.map((l) => ({ productId: l.productId!, quantity: l.quantity, amountUnits: l.amount })),
      note: note.trim() || undefined,
    };
    const r = await run((idempotencyKey) => reauth.run(() => submit({ ...payload, idempotencyKey })));
    setPending(false);
    if (r.ok) {
      return onDone(
        paidFrom === "cash"
          ? `Compra registrada: salieron ${r.data.totalLabel} de la caja`
          : paidFrom === "bank"
            ? `Compra registrada: ${r.data.totalLabel} del banco`
            : `Carga inicial registrada: ${r.data.totalLabel}`,
      );
    }
    setError(isCashShort?.(r.error) ? `${r.error}. Revisa el total de la compra.` : r.error);
  }

  if (products.length === 0) {
    return <p className="text-sm text-tinta/70">No hay productos activos. El dueño los crea en Productos.</p>;
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      {paidFromOptions.length > 1 ? (
        <RadioGroup value={paidFrom} onChange={(v) => setPaidFrom(v as PurchasePaidFrom)} className={field.root}>
          <Label className={field.label}>Se pagó</Label>
          <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
            {paidFromOptions
              .filter((p): p is Exclude<PurchasePaidFrom, "cash"> => p !== "cash")
              .map((p) => (
                <Radio key={p} value={p} className={cx(radioCard, "group")}>
                  <RadioDot />
                  <span className="flex flex-col">
                    <span className="inline-flex items-center gap-1.5">
                      {p === "bank" ? <Landmark size={16} aria-hidden /> : <PackagePlus size={16} aria-hidden />} {PAID_FROM_OPTIONS[p].label}
                    </span>
                    <span className="text-xs font-normal text-tinta/70">{PAID_FROM_OPTIONS[p].hint}</span>
                  </span>
                </Radio>
              ))}
          </div>
        </RadioGroup>
      ) : paidFrom === "cash" ? (
        <p className="flex items-center gap-2 text-sm text-tinta/70">
          <Wallet size={16} aria-hidden /> Sale del efectivo de la caja.
        </p>
      ) : null}

      <ol className="flex flex-col gap-3" aria-label="Productos de la compra">
        {lines.map((l, i) => (
          <li key={l.key} className="flex flex-col gap-3 rounded-xl border border-tinta/10 p-3">
            <div className="flex items-start gap-2">
              <SelectField
                className="min-w-0 flex-1"
                label={`Producto ${i + 1}`}
                options={products.map((p) => ({ id: p.id, label: p.name, isDisabled: p.id !== l.productId && chosen.has(p.id) }))}
                value={l.productId}
                onChange={(v) => update(l.key, { productId: v })}
                isRequired
              />
              {lines.length > 1 ? (
                <Btn
                  variant="ghost"
                  className="mt-7 shrink-0"
                  aria-label={`Quitar el producto ${i + 1}`}
                  onPress={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                >
                  <Trash2 size={16} aria-hidden />
                </Btn>
              ) : null}
            </div>
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <TextField
                value={l.quantity}
                onChange={(v) => update(l.key, { quantity: onlyDigits(v, 6) })}
                inputMode="numeric"
                isRequired
                className={field.root}
              >
                <Label className={field.label}>Unidades</Label>
                <Input className={cx(field.input, "monto")} autoComplete="off" />
              </TextField>
              <MoneyField label="Costo total" value={l.amount} onChange={(v) => update(l.key, { amount: v })} isRequired />
            </div>
            {lineErrors[l.key] ? (
              <p role="alert" className={field.error}>
                {lineErrors[l.key]}
              </p>
            ) : null}
          </li>
        ))}
      </ol>

      {lines.length < products.length ? (
        <Btn variant="secondary" className="self-start" onPress={() => setLines((ls) => [...ls, emptyLine()])}>
          <Plus size={18} aria-hidden /> Agregar otro producto
        </Btn>
      ) : null}

      <TextField value={note} onChange={setNote} maxLength={200} className={field.root}>
        <Label className={field.label}>Nota (opcional)</Label>
        <Input className={field.input} placeholder="Proveedor o número de factura" autoComplete="off" />
      </TextField>

      <div aria-live="polite" className="flex items-center justify-between rounded-xl border border-botella/20 bg-botella/5 px-4 py-3 text-sm">
        <span>Total de la compra</span>
        <span className="monto text-lg font-semibold">{format(total)}</span>
      </div>

      {highCost.length > 0 && !needsConfirm ? (
        <div role="alert" className="flex flex-col gap-1 rounded-xl border border-alerta/30 bg-alerta/5 px-4 py-3 text-sm">
          <p className="font-semibold">Revisa el costo antes de registrar: la compra no se puede borrar.</p>
          <ul className="flex flex-col gap-0.5">
            {highCost.map((h) => (
              <li key={h.name}>
                {h.name}: cuesta <span className="monto font-semibold">{format(h.unitCost)}</span> por unidad y se vende a{" "}
                <span className="monto">{format(h.price)}</span>.
              </li>
            ))}
          </ul>
          <p className="text-tinta/80">El costo es el TOTAL de la línea (todas las unidades). Si está bien, confirma.</p>
        </div>
      ) : null}

      <FormError message={error} />
      <SheetFooter className="flex-col-reverse min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" isPending={pending}>
          <PackagePlus size={18} aria-hidden /> {highCost.length > 0 && !needsConfirm ? "Sí, registrar compra" : "Registrar compra"}
        </Btn>
      </SheetFooter>
      {reauth.dialog}
    </Form>
  );
}
