"use client";

import { HandCoins, Landmark, PackagePlus, Undo2, Wallet } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Form, Label, Radio, RadioGroup } from "react-aria-components";
import { format, fromUnits, money } from "@/domain/money";
import { callAction, MoneyField, newKey, unitsOf } from "../_components/money-field";
import { useReauth } from "../_components/reauth";
import { Btn, cx, field, Sheet, SheetFooter, useToast } from "../_components/ui";
import { card, FormError, RadioDot, radioCard } from "../_manage/controls";
import { paySupplierAction, reverseSupplierPaymentAction } from "./actions";

// Cuentas por pagar a proveedores (sprint 8, parte A; docs/sprint-8-gastos-controles.md §5b): lo que
// se le debe a cada proveedor por las compras a crédito, cuándo vence y sus pagos. Pagar o anular un
// pago lo hace el servidor (que vuelve a validar todo); aquí solo hay vistas previas con money.ts.

type Source = "cash" | "bank" | "owner";

export interface PayablePaymentRow {
  id: string;
  dateLabel: string;
  amountLabel: string;
  paidFrom: Source;
  paidFromLabel: string;
  reversed: boolean;
  /** Por qué ya no se puede anular (turno cerrado), o null si se puede. */
  lockMessage: string | null;
}

export interface PayableRow {
  documentId: string;
  supplierName: string;
  summary: string;
  dateLabel: string;
  dueDateLabel: string;
  /** "Vencida hace 3 días", "Vence hoy", "Vence en 5 días". */
  dueLabel: string;
  dueState: "overdue" | "today" | "soon" | "later";
  totalLabel: string;
  /** Lo abonado (pagos vigentes), o null si todavía no hay abonos. */
  paidLabel: string | null;
  /** Centavos (texto) y pesos enteros (texto) de lo que falta: para validar y prellenar el pago. */
  outstandingMinor: string;
  outstandingUnits: string;
  outstandingLabel: string;
  payments: PayablePaymentRow[];
}

export interface PayablesData {
  /** Saldo de 2205 según el libro. */
  balanceLabel: string;
  pendingCount: number;
  rows: PayableRow[];
}

const SOURCES: Record<Source, { label: string; hint: string; icon: typeof Wallet }> = {
  bank: { label: "Banco", hint: "Transferencia del negocio", icon: Landmark },
  cash: { label: "Caja", hint: "Efectivo del turno abierto", icon: Wallet },
  owner: { label: "Bolsillo del dueño", hint: "Queda como aporte del dueño", icon: PackagePlus },
};

const REVERSE_EFFECT: Record<Source, string> = {
  cash: "El efectivo vuelve a la caja de este turno.",
  bank: "El dinero vuelve a la cuenta del banco.",
  owner: "Se retira del aporte del dueño.",
};

const DUE_TONE: Record<PayableRow["dueState"], string> = {
  overdue: "bg-alerta/10 text-alerta",
  today: "bg-cuero/15 text-tinta",
  soon: "bg-cuero/15 text-tinta",
  later: "bg-tinta/5 text-tinta/70",
};

type Open = { mode: "pay"; row: PayableRow } | { mode: "reverse"; row: PayableRow; payment: PayablePaymentRow } | null;

export function PayablesSection({ data }: { data: PayablesData }) {
  const toast = useToast();
  const [open, setOpen] = useState<Open>(null);
  const done = (m: string) => {
    setOpen(null);
    toast(m);
  };

  if (data.rows.length === 0) return null;

  return (
    <section aria-labelledby="cuentas-por-pagar" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="cuentas-por-pagar" className="font-display text-xl">
          Cuentas por pagar
        </h2>
        <p className="text-sm text-tinta/70">
          Se les debe <span className="monto font-semibold text-tinta">{data.balanceLabel}</span> a los proveedores
          {data.pendingCount > 0 ? ` (${data.pendingCount} ${data.pendingCount === 1 ? "compra pendiente" : "compras pendientes"})` : ""}. Lo que vence primero va
          arriba.
        </p>
      </div>
      <ul className="flex flex-col gap-2" aria-label="Cuentas por pagar">
        {data.rows.map((r) => {
          const paidOff = r.outstandingMinor === "0";
          return (
            <li key={r.documentId} className={cx(card, "flex flex-col gap-3 p-4", paidOff && "bg-papel/60")}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="text-base font-semibold">{r.supplierName}</p>
                  <p className="text-sm text-tinta/70">{r.summary}</p>
                  <p className="text-xs text-tinta/70">
                    Compra del {r.dateLabel} · vence el {r.dueDateLabel}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="monto text-lg font-semibold">{paidOff ? r.totalLabel : r.outstandingLabel}</span>
                  {paidOff ? (
                    <span className="rounded-full bg-botella/10 px-2 py-0.5 text-xs font-semibold text-botella">Pagada</span>
                  ) : (
                    <span className={cx("rounded-full px-2 py-0.5 text-xs font-semibold", DUE_TONE[r.dueState])}>{r.dueLabel}</span>
                  )}
                </div>
              </div>
              {!paidOff && r.paidLabel ? (
                <p className="text-xs text-tinta/70">
                  Abonado <span className="monto">{r.paidLabel}</span> de <span className="monto">{r.totalLabel}</span>
                </p>
              ) : null}

              {r.payments.length > 0 ? (
                <ul className="flex flex-col gap-2 border-t border-tinta/10 pt-3" aria-label={`Pagos a ${r.supplierName}`}>
                  {r.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className={cx(p.reversed && "text-tinta/70 line-through")}>
                        {p.dateLabel} · <span className="monto font-semibold">{p.amountLabel}</span> {p.paidFromLabel}
                      </span>
                      {p.reversed ? (
                        <span className="text-xs font-semibold text-tinta/70">Anulado</span>
                      ) : p.lockMessage ? (
                        <span className="text-xs text-tinta/70">No se puede anular: su turno de caja ya se cerró</span>
                      ) : (
                        <Btn
                          variant="ghost"
                          size="sm"
                          onPress={() => setOpen({ mode: "reverse", row: r, payment: p })}
                          aria-label={`Anular el pago de ${p.amountLabel} del ${p.dateLabel}`}
                        >
                          <Undo2 size={16} aria-hidden />
                          Anular
                        </Btn>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}

              {!paidOff ? (
                <Btn size="sm" className="self-start" onPress={() => setOpen({ mode: "pay", row: r })}>
                  <HandCoins size={16} aria-hidden />
                  Pagar
                </Btn>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Sheet
        isOpen={open?.mode === "pay"}
        onOpenChange={(o) => !o && setOpen(null)}
        title={open?.mode === "pay" ? `Pagar a ${open.row.supplierName}` : "Pagar"}
        description={open?.mode === "pay" ? `${open.row.summary} · se debe ${open.row.outstandingLabel}` : undefined}
      >
        {open?.mode === "pay" ? <PayForm key={open.row.documentId} row={open.row} onDone={done} onCancel={() => setOpen(null)} /> : null}
      </Sheet>

      <Sheet
        isOpen={open?.mode === "reverse"}
        onOpenChange={(o) => !o && setOpen(null)}
        title="Anular pago"
        description={open?.mode === "reverse" ? `${open.row.supplierName} · ${open.payment.amountLabel}` : undefined}
      >
        {open?.mode === "reverse" ? <ReversePayment row={open.row} payment={open.payment} onDone={done} onCancel={() => setOpen(null)} /> : null}
      </Sheet>
    </section>
  );
}

function PayForm({ row, onDone, onCancel }: { row: PayableRow; onDone: (m: string) => void; onCancel: () => void }) {
  const reauth = useReauth({ description: "Un pago del banco o del bolsillo del dueño cambia las cuentas sin pasar por la caja." });
  // Se conserva ante un fallo de red (el reintento no paga dos veces) y se renueva tras una respuesta.
  const key = useRef(newKey());
  const [amount, setAmount] = useState(row.outstandingUnits);
  const [source, setSource] = useState<Source>("bank");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const value = fromUnits(unitsOf(amount));
  const owed = money(BigInt(row.outstandingMinor));
  const settles = value.minor === owed.minor;
  const left = value.minor < owed.minor ? money(owed.minor - value.minor) : null;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (value.minor <= 0n) return setError("Escribe cuánto se le paga.");
    if (value.minor > owed.minor) return setError(`Es más de lo que se debe de esta compra (${row.outstandingLabel}).`);
    setPending(true);
    const r = await callAction(() =>
      reauth.run(() => paySupplierAction({ documentId: row.documentId, amountUnits: amount, paidFrom: source, idempotencyKey: key.current })),
    );
    if (!("network" in r && r.network)) key.current = newKey();
    setPending(false);
    if (r.ok) {
      return onDone(
        r.data.created
          ? `Pagaste ${r.data.amountLabel} a ${r.data.supplierName}. ${settles ? "Esa compra quedó pagada." : `De esa compra se debe ${r.data.remainingLabel}.`}`
          : "Ese pago ya estaba registrado",
      );
    }
    setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <MoneyField
        label="Cuánto se le paga"
        value={amount}
        onChange={(v) => {
          setAmount(v);
          setError(null);
        }}
        size="lg"
        isRequired
        description={settles ? "Paga todo lo que se debe de esta compra." : left ? `Abono: quedarían ${format(left)} por pagar.` : undefined}
      />
      <RadioGroup value={source} onChange={(v) => setSource(v as Source)} className={field.root}>
        <Label className={field.label}>Sale de</Label>
        <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-3">
          {(["bank", "cash", "owner"] as const).map((s) => {
            const Icon = SOURCES[s].icon;
            return (
              <Radio key={s} value={s} className={cx(radioCard, "group")}>
                <RadioDot />
                <span className="flex flex-col">
                  <span className="inline-flex items-center gap-1.5">
                    <Icon size={16} aria-hidden /> {SOURCES[s].label}
                  </span>
                  <span className="text-xs font-normal text-tinta/70">{SOURCES[s].hint}</span>
                </span>
              </Radio>
            );
          })}
        </div>
      </RadioGroup>
      <FormError message={error} />
      <SheetFooter className="flex-col-reverse min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" isPending={pending}>
          <HandCoins size={18} aria-hidden /> Registrar pago
        </Btn>
      </SheetFooter>
      {reauth.dialog}
    </Form>
  );
}

function ReversePayment({
  row,
  payment,
  onDone,
  onCancel,
}: {
  row: PayableRow;
  payment: PayablePaymentRow;
  onDone: (m: string) => void;
  onCancel: () => void;
}) {
  const reauth = useReauth({ description: "Anular un pago devuelve el dinero y la deuda con el proveedor vuelve a subir." });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    const r = await callAction(() => reauth.run(() => reverseSupplierPaymentAction({ paymentId: payment.id })));
    setPending(false);
    if (r.ok) return onDone(r.data.created ? `Pago anulado: se le vuelven a deber ${r.data.amountLabel} a ${row.supplierName}` : "Ese pago ya estaba anulado");
    setError(r.error);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 text-sm">
        <p>
          Se anula el pago de <span className="monto font-semibold">{payment.amountLabel}</span> del {payment.dateLabel}, hecho {payment.paidFromLabel}.{" "}
          {REVERSE_EFFECT[payment.paidFrom]} La deuda con {row.supplierName} vuelve a subir lo mismo.
        </p>
        <p className="text-tinta/70">No se puede deshacer. Si el pago fue real con otro valor, regístralo de nuevo después.</p>
      </div>
      <FormError message={error} />
      <SheetFooter className="flex-col-reverse min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn variant="danger" onPress={confirm} isPending={pending}>
          <Undo2 size={18} aria-hidden /> Anular pago
        </Btn>
      </SheetFooter>
      {reauth.dialog}
    </div>
  );
}
