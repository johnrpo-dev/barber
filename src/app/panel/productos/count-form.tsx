"use client";

import { ClipboardCheck } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Form, Input, Label, TextField } from "react-aria-components";
import { expectedUnits, MAX_QUANTITY, unitDifference, valueCountLine } from "@/domain/inventory/periodic";
import { format, money, negate, subtract, sum } from "@/domain/money";
import { callAction, newKey, onlyDigits } from "../_components/money-field";
import { plural } from "../_components/dates";
import { useReauth } from "../_components/reauth";
import { Btn, cx, field, SheetFooter } from "../_components/ui";
import { FormError } from "../_manage/controls";
import { recordCountAction } from "./actions";

// Conteo de inventario (sprint 6, fase D): el dueño escribe cuántas unidades hay de cada producto. Al
// lado ve las que debería haber (conteo anterior + compras − ventas) y la diferencia. El valor y el
// ajuste son una vista previa con money.ts al costo de la última compra; el servidor recalcula todo y
// la base exige que 1435 quede en lo contado.

export interface CountProduct {
  id: string;
  name: string;
  active: boolean;
  base: number;
  purchased: number;
  sold: number;
  /** Centavos (texto) y unidades de la línea de la última compra; null si nunca se compró. */
  costMinor: string | null;
  costQuantity: number | null;
}

export interface CountSheetData {
  products: CountProduct[];
  /** Saldo de 1435 en centavos (texto). */
  bookMinor: string;
  /** "30 de octubre", o null si es el primer conteo. */
  lastCountLabel: string | null;
}

/** Un conteo guardado con sus diferencias por producto, listo para mostrar. */
export interface CountHistoryRow {
  id: string;
  dateLabel: string;
  totalLabel: string;
  /** Valor absoluto del ajuste; adjustment dice hacia dónde fue. */
  adjustmentLabel: string;
  adjustment: "cost" | "surplus" | "none";
  previousLabel: string | null;
  /** Unidades que faltaron (suma de las diferencias negativas). */
  missingUnits: number;
  rows: { name: string; base: number; purchased: number; sold: number; expected: number; counted: number; difference: number; valueLabel: string }[];
}

/** "Falta 1", "Sobran 2" o "Cuadra". */
export function differenceLabel(difference: number): string {
  if (difference === 0) return "Cuadra";
  const n = Math.abs(difference);
  return difference < 0 ? `${n === 1 ? "Falta" : "Faltan"} ${n}` : `${n === 1 ? "Sobra" : "Sobran"} ${n}`;
}

function differenceClass(difference: number): string {
  return difference < 0 ? "text-alerta" : difference > 0 ? "text-botella" : "text-tinta/70";
}

/** "10 del conteo + 5 compradas − 2 vendidas" (sin los términos en cero). */
export function movementText(m: { base: number; purchased: number; sold: number }, hasPrevious: boolean): string {
  const parts = [hasPrevious ? `${m.base} del conteo` : null, m.purchased ? `+ ${plural(m.purchased, "comprada", "compradas")}` : null];
  if (m.sold > 0) parts.push(`− ${plural(m.sold, "vendida", "vendidas")}`);
  if (m.sold < 0) parts.push(`+ ${-m.sold} de ventas anuladas`);
  const text = parts.filter(Boolean).join(" ");
  return text.replace(/^\+ /, "") || "sin movimientos";
}

function quantityOf(text: string): number | null {
  if (text === "") return null;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function CountForm({ sheet, onDone, onCancel }: { sheet: CountSheetData; onDone: (message: string) => void; onCancel: () => void }) {
  const reauth = useReauth({ description: "El conteo deja el inventario en lo contado y lleva la diferencia al costo de ventas." });
  const key = useRef(newKey());
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hasPrevious = sheet.lastCountLabel !== null;

  // Vista previa: cada línea al costo de la última compra, la suma exacta y el ajuste contra el libro.
  const values = sheet.products.map((p) => {
    const q = quantityOf(counted[p.id] ?? "");
    if (q === null || q > MAX_QUANTITY) return { value: money(0n), costKnown: true, q };
    const last = p.costMinor !== null && p.costQuantity !== null ? { quantity: p.costQuantity, amount: money(BigInt(p.costMinor)) } : null;
    return { ...valueCountLine(q, last), q };
  });
  const total = sum(values.map((v) => v.value));
  const book = money(BigInt(sheet.bookMinor));
  const adjustment = subtract(book, total);
  const allTyped = values.every((v) => v.q !== null);
  const noCost = sheet.products.filter((p, i) => (values[i]!.q ?? 0) > 0 && !values[i]!.costKnown).map((p) => p.name);

  function set(id: string, v: string) {
    setCounted((c) => ({ ...c, [id]: onlyDigits(v, 6) }));
    setMissing((m) => {
      if (!m.has(id)) return m;
      const rest = new Set(m);
      rest.delete(id);
      return rest;
    });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const empty = sheet.products.filter((p) => (counted[p.id] ?? "") === "").map((p) => p.id);
    setMissing(new Set(empty));
    if (empty.length > 0) return setError(`Falta escribir ${plural(empty.length, "producto", "productos")}: pon 0 si no hay.`);
    if (values.some((v) => (v.q ?? 0) > MAX_QUANTITY)) return setError(`Las unidades contadas deben estar entre 0 y ${MAX_QUANTITY}.`);
    setPending(true);
    const payload = { lines: sheet.products.map((p) => ({ productId: p.id, quantity: counted[p.id]! })), note: note.trim() || undefined };
    const r = await callAction(() => reauth.run(() => recordCountAction({ ...payload, idempotencyKey: key.current })));
    if (!("network" in r && r.network)) key.current = newKey();
    setPending(false);
    if (!r.ok) return setError(r.error);
    if (!r.data.created) return onDone("Ese conteo ya estaba guardado");
    onDone(
      r.data.adjustment === "cost"
        ? `Conteo guardado: el inventario vale ${r.data.totalLabel}; ${r.data.adjustmentLabel} pasan al costo de ventas`
        : r.data.adjustment === "surplus"
          ? `Conteo guardado: el inventario vale ${r.data.totalLabel}; sobraron ${r.data.adjustmentLabel}`
          : `Conteo guardado: el inventario vale ${r.data.totalLabel} y cuadra con el libro`,
    );
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <p className="text-sm text-tinta/70">
        Cuenta lo que hay en el estante y en la bodega. Escribe las unidades de cada producto, 0 si no hay.
        {hasPrevious ? ` Lo que debería haber sale del conteo del ${sheet.lastCountLabel}.` : " Es el primer conteo: lo que debería haber sale de las compras."}
      </p>

      <ul className="flex flex-col gap-2" aria-label="Productos a contar">
        {sheet.products.map((p) => {
          const expected = expectedUnits(p);
          const q = quantityOf(counted[p.id] ?? "");
          const diff = q === null ? null : unitDifference(q, p);
          return (
            <li key={p.id} className={cx("flex items-center gap-3 rounded-xl border p-3", missing.has(p.id) ? "border-alerta/50" : "border-tinta/10")}>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-sm font-semibold">
                  {p.name}
                  {p.active ? null : <span className="ml-1.5 text-xs font-normal text-tinta/70">(retirado)</span>}
                </p>
                <p className="text-xs text-tinta/70">
                  Debería haber <span className="monto font-semibold text-tinta">{expected}</span>
                  <span className="block">{movementText(p, hasPrevious)}</span>
                </p>
                {diff !== null ? <p className={cx("text-xs font-semibold", differenceClass(diff))}>{differenceLabel(diff)}</p> : null}
              </div>
              <TextField
                value={counted[p.id] ?? ""}
                onChange={(v) => set(p.id, v)}
                inputMode="numeric"
                isRequired
                isInvalid={missing.has(p.id)}
                className="flex w-20 shrink-0 flex-col gap-1"
              >
                <Label className="text-xs text-tinta/70">
                  Hay<span className="sr-only"> de {p.name}</span>
                </Label>
                <Input className={cx(field.input, "monto text-center")} autoComplete="off" placeholder="0" />
              </TextField>
            </li>
          );
        })}
      </ul>

      <TextField value={note} onChange={setNote} maxLength={200} className={field.root}>
        <Label className={field.label}>Nota (opcional)</Label>
        <Input className={field.input} placeholder="Quién contó o algo que pasó" autoComplete="off" />
      </TextField>

      <dl aria-live="polite" className="flex flex-col gap-1 rounded-xl border border-botella/20 bg-botella/5 px-4 py-3 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt>Inventario según el libro</dt>
          <dd className="monto">{format(book)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt>Valor contado{allTyped ? "" : " (hasta ahora)"}</dt>
          <dd className="monto text-lg font-semibold">{format(total)}</dd>
        </div>
        {allTyped ? (
          <div className="flex items-baseline justify-between gap-3 border-t border-botella/20 pt-1">
            <dt>{adjustment.minor > 0n ? "Pasa al costo de ventas" : adjustment.minor < 0n ? "Sobrante" : "Ajuste"}</dt>
            <dd className="monto font-semibold">{format(adjustment.minor < 0n ? negate(adjustment) : adjustment)}</dd>
          </div>
        ) : null}
      </dl>
      <p className="text-xs text-tinta/70">
        Cada producto vale al costo de su última compra. El costo de ventas es lo vendido más lo que se perdió o se usó en el local. Un conteo no se borra: si te
        equivocas, cuenta de nuevo.
      </p>

      {noCost.length > 0 ? (
        <p role="note" className="rounded-xl border border-alerta/30 bg-alerta/5 px-4 py-3 text-sm">
          {noCost.join(", ")} {noCost.length === 1 ? "no tiene compras registradas: vale $ 0" : "no tienen compras registradas: valen $ 0"}. Registra la compra
          (o la carga inicial) antes de contar.
        </p>
      ) : null}

      <FormError message={error} />
      <SheetFooter className="flex-col-reverse min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" isPending={pending}>
          <ClipboardCheck size={18} aria-hidden /> Guardar conteo
        </Btn>
      </SheetFooter>
      {reauth.dialog}
    </Form>
  );
}

export function CountReportView({ count }: { count: CountHistoryRow }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-1 rounded-xl border border-tinta/10 px-4 py-3 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt>Valor contado</dt>
          <dd className="monto font-semibold">{count.totalLabel}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt>{count.adjustment === "cost" ? "Pasó al costo de ventas" : count.adjustment === "surplus" ? "Sobrante" : "Ajuste"}</dt>
          <dd className="monto">{count.adjustmentLabel}</dd>
        </div>
      </dl>
      <p className="text-sm text-tinta/70">
        Debería haber = {count.previousLabel ? `conteo del ${count.previousLabel}` : "nada antes (primer conteo)"} + compras − ventas (las anuladas no cuentan).
        Las unidades que faltan pueden ser consumo del local, pérdidas o ventas sin cobrar.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Diferencias por producto</caption>
          <thead>
            <tr className="border-b border-tinta/10 text-xs text-tinta/70">
              <th scope="col" className="py-1.5 pr-2 font-normal">
                Producto
              </th>
              <th scope="col" className="px-1 py-1.5 text-right font-normal">
                Debería
              </th>
              <th scope="col" className="px-1 py-1.5 text-right font-normal">
                Hay
              </th>
              <th scope="col" className="py-1.5 pl-1 text-right font-normal">
                Diferencia
              </th>
            </tr>
          </thead>
          <tbody>
            {count.rows.map((r) => (
              <tr key={r.name} className="border-b border-tinta/10 align-top">
                <th scope="row" className="py-1.5 pr-2 font-normal">
                  {r.name}
                  <span className="block text-xs text-tinta/70">{r.valueLabel}</span>
                </th>
                <td className="monto px-1 py-1.5 text-right">{r.expected}</td>
                <td className="monto px-1 py-1.5 text-right">{r.counted}</td>
                <td className={cx("py-1.5 pl-1 text-right text-xs font-semibold", differenceClass(r.difference))}>{differenceLabel(r.difference)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
