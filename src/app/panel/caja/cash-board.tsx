"use client";

import { ArrowDownLeft, ArrowUpRight, CalendarCheck, CalendarX, CheckCircle2, EyeOff, HandCoins, Landmark, Lock, LockOpen, Receipt, ShieldAlert, TriangleAlert, Undo2, Wallet, Plus, Printer, Banknote } from "lucide-react";
import Link from "next/link";
import { type FormEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { Form, Input, Label, Radio, RadioGroup, TextArea, TextField } from "react-aria-components";
import { format, money, PESO } from "@/domain/money";
import type { ActionResult } from "@/lib/action";
import { card, Chip, FieldMessage, FormError, RadioDot, radioCard, useFieldErrors } from "../_manage/controls";
import { callAction, MoneyField, newKey, onlyDigits, unitsOf } from "../_components/money-field";
import { useReauth } from "../_components/reauth";
import { SelectField } from "../_components/select-field";
import { Btn, cx, field, PageHeader, Sheet, useToast } from "../_components/ui";
import { plural } from "../_components/dates";
import { longDate } from "../agenda/_components/slot-picker";
import { requestVoidAction } from "../cobro/actions";
import { CheckoutSheet } from "../cobro/checkout-sheet";
import {
  addExpenseAction,
  cashDepositAction,
  closeCashSessionAction,
  closeDayAction,
  loadCashView,
  markCashSessionReviewedAction,
  openCashSessionAction,
  payTipsAction,
  reopenDayAction,
} from "./actions";

// Caja (docs/sprint-4-cobro-caja.md §4 y §7). Es la pantalla de cobro de recepción: arriba "Nuevo
// cobro" y "Por cobrar" (citas en la silla o terminadas, sin venta), luego los cobros de hoy con su
// recibo, y abajo el turno: efectivo esperado (sale de SQL), movimientos, gastos, propinas,
// consignaciones, cierre con conteo y cierre del día.
// Los montos que se ven vienen ya formateados del servidor; la interfaz solo previsualiza la diferencia.

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
export type CashView = OkData<Awaited<ReturnType<typeof loadCashView>>>;
type Session = NonNullable<CashView["session"]>;
type DaySale = CashView["daySales"][number];

const big = (s: string) => (/^-?\d+$/.test(s) ? BigInt(s) : 0n);
const fmt = (minor: bigint) => format(money(minor));

const MOVEMENT_LABEL: Record<Session["movements"][number]["kind"], string> = {
  sale: "Venta",
  expense: "Gasto",
  tip_payout: "Propinas",
  cash_deposit: "Consignación",
  cash_adjustment: "Ajuste",
  reversal: "Reversa",
  commission_payout: "Liquidación",
  staff_advance: "Anticipo",
};

type SheetState =
  | { kind: "open" | "close" | "expense" | "tips" | "deposit" | "closeDay" | "closePendingDay" | "reopen" }
  | { kind: "void"; sale: DaySale }
  | null;

/** Clave de idempotencia de un formulario: se conserva ante un fallo de red y se renueva tras una respuesta. */
function useKeyedAction() {
  const key = useRef(newKey());
  return useCallback(async <T,>(fn: (idempotencyKey: string) => Promise<ActionResult<T>>) => {
    const r = await callAction(() => fn(key.current));
    if (!("network" in r && r.network)) key.current = newKey();
    return r;
  }, []);
}

export function CashBoard({ initial }: { initial: CashView }) {
  const toast = useToast();
  const [view, setView] = useState(initial);
  const [sheet, setSheet] = useState<SheetState>(null);
  /** Cobro sin cita desde la caja (walk-in que no pasó por la agenda). */
  const [walkIn, setWalkIn] = useState(false);
  /** Cobro de una cita de "Por cobrar". */
  const [charging, setCharging] = useState<{ id: string; clientName: string | null } | null>(null);

  const refresh = useCallback(async () => {
    const r = await callAction(() => loadCashView());
    if (r.ok) setView(r.data);
    else toast(r.error, "error");
  }, [toast]);

  const done = useCallback(
    (message: string) => {
      setSheet(null);
      toast(message);
      void refresh();
    },
    [refresh, toast],
  );

  const s = view.session;
  /** La caja quedó abierta de un día anterior: no recibe efectivo de hoy hasta cerrarla contando. */
  const stale = s?.staleDayLabel ?? null;
  const closeSheet = () => setSheet(null);
  const startClose = () => {
    void refresh();
    setSheet({ kind: "close" });
  };

  return (
    <>
      <PageHeader
        eyebrow={longDate(view.businessDate)}
        title="Caja"
        actions={
          view.dayClosed ? (
            <Chip tone="muted" icon={<Lock size={14} aria-hidden />}>
              Día cerrado
            </Chip>
          ) : stale ? (
            <Chip tone="primary" icon={<TriangleAlert size={14} aria-hidden />}>
              Caja de otro día
            </Chip>
          ) : s ? (
            <Chip tone="success" icon={<LockOpen size={14} aria-hidden />}>
              Caja abierta
            </Chip>
          ) : (
            <Chip tone="muted" icon={<Lock size={14} aria-hidden />}>
              Caja cerrada
            </Chip>
          )
        }
      />

      {/* Caja cerrada: lo primero es abrirla (sin ella no entra efectivo). */}
      {!s && !view.dayClosed ? (
        <div className="flex flex-col gap-3 rounded-xl border border-cuero/30 bg-cuero/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Lock size={20} className="mt-0.5 shrink-0 text-cuero" aria-hidden />
            <div className="flex flex-col gap-0.5">
              <p className="font-semibold">Abre la caja para empezar</p>
              <p className="text-sm text-tinta/80">Cuenta la base. Mientras esté cerrada solo se cobra con tarjeta, transferencia o billetera.</p>
            </div>
          </div>
          <Btn className="shrink-0" onPress={() => setSheet({ kind: "open" })}>
            <LockOpen size={18} aria-hidden /> Abrir caja
          </Btn>
        </div>
      ) : null}
      {/* Se olvidó cerrar la caja: se cierra tarde contando, y después se abre la de hoy (sin reabrir nada). */}
      {stale && !view.dayClosed ? (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-alerta/30 bg-alerta/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <TriangleAlert size={20} className="mt-0.5 shrink-0 text-alerta" aria-hidden />
            <div className="flex flex-col gap-0.5">
              <p className="font-semibold">La caja del {stale} sigue abierta</p>
              <p className="text-sm text-tinta/80">
                Ciérrala contando el efectivo y después abre la de hoy. Así las ventas de cada día no se mezclan. Mientras tanto solo se cobra con
                tarjeta, transferencia o billetera.
              </p>
            </div>
          </div>
          <Btn className="shrink-0" onPress={startClose}>
            <Lock size={18} aria-hidden /> Cerrar esa caja
          </Btn>
        </div>
      ) : null}
      {/* Día de hoy cerrado: nadie abre caja ni cobra hasta que el dueño lo reabra (es su control). */}
      {view.dayClosed ? (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-alerta/30 bg-alerta/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <CalendarX size={20} className="mt-0.5 shrink-0 text-alerta" aria-hidden />
            <div className="flex flex-col gap-0.5">
              <p className="font-semibold">El día de hoy está cerrado</p>
              <p className="text-sm text-tinta/80">
                Por eso no se puede abrir la caja ni cobrar.{" "}
                {view.canReopenDay
                  ? "Si se cerró por error, reábrelo: queda registrado con tu nombre y el motivo."
                  : "Si se cerró por error, pídele al dueño que lo reabra desde Caja; recepción no puede reabrir días."}
              </p>
            </div>
          </div>
          {view.canReopenDay ? (
            <Btn variant="danger" className="shrink-0" onPress={() => setSheet({ kind: "reopen" })}>
              <CalendarX size={18} aria-hidden /> Reabrir el día
            </Btn>
          ) : null}
        </div>
      ) : null}

      {/* Cobrar: la acción principal de la pantalla */}
      <section aria-labelledby="cobrar" className="flex flex-col gap-2">
        <h2 id="cobrar" className="sr-only">
          Cobrar
        </h2>
        <Btn size="lg" className="h-16 w-full text-lg" onPress={() => setWalkIn(true)} isDisabled={view.dayClosed}>
          <Plus size={22} aria-hidden /> Nuevo cobro
        </Btn>
        <p className="text-center text-sm text-tinta/70">Para quien llega sin cita: eliges servicios, barbero y medio de pago.</p>
      </section>

      {/* Por cobrar: citas de hoy en la silla o terminadas, sin venta */}
      <section aria-labelledby="por-cobrar" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id="por-cobrar" className="font-display text-2xl leading-tight">
            Por cobrar
          </h2>
          {view.toCharge.length > 0 ? <span className="monto text-sm font-semibold text-cuero">{plural(view.toCharge.length, "cita", "citas")}</span> : null}
        </div>
        {view.toCharge.length === 0 ? (
          <p className={cx(card, "p-4 text-sm text-tinta/70")}>Nadie esperando cobro. Las citas aparecen aquí cuando el cliente pasa a la silla en la agenda.</p>
        ) : (
          <ul className={cx(card, "divide-y divide-tinta/10")} role="list">
            {view.toCharge.map((a) => (
              <li key={a.appointmentId} className="flex items-center gap-3 px-4 py-3">
                <span className="monto w-12 shrink-0 text-sm text-tinta/70">{a.timeLabel}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{a.clientName ?? "Sin nombre"}</p>
                  <p className="truncate text-xs text-tinta/70">
                    {a.serviceName} · {a.staffName} · {a.inChair ? "en la silla" : "terminó"}
                  </p>
                </div>
                <span className="monto hidden shrink-0 font-semibold min-[400px]:inline">{a.priceLabel}</span>
                <Btn size="sm" className="h-11 shrink-0" onPress={() => setCharging({ id: a.appointmentId, clientName: a.clientName })} isDisabled={view.dayClosed}>
                  Cobrar<span className="sr-only"> a {a.clientName ?? "la cita"} de las {a.timeLabel}</span>
                </Btn>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Cobros de hoy */}
      <section aria-labelledby="ventas" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id="ventas" className="font-display text-2xl leading-tight">
            Cobros de hoy
          </h2>
          {view.daySales.length > 0 ? <span className="monto text-sm text-tinta/70">{plural(view.daySales.filter((x) => x.status === "paid").length, "cobro", "cobros")}</span> : null}
        </div>
        {view.daySales.length === 0 ? (
          <p className={cx(card, "p-4 text-sm text-tinta/70")}>Todavía no hay cobros hoy.</p>
        ) : (
          <ul className={cx(card, "divide-y divide-tinta/10")} role="list">
            {view.daySales.map((sale) => (
              <li key={sale.saleId} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{sale.clientName ?? "Sin nombre"}</p>
                    <p className="text-xs text-tinta/70">
                      <span className="monto">{sale.atLabel}</span> · Cobró {sale.chargedBy}
                    </p>
                  </div>
                  <span className={cx("monto shrink-0 font-semibold", sale.status === "voided" && "text-tinta/60 line-through")}>{sale.totalLabel}</span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {sale.status === "voided" ? (
                    <Chip tone="muted" icon={<Undo2 size={12} aria-hidden />}>
                      Anulada
                    </Chip>
                  ) : sale.voidRequested ? (
                    <Chip tone="primary" icon={<TriangleAlert size={12} aria-hidden />}>
                      Anulación pedida
                    </Chip>
                  ) : (
                    <Chip tone="success" icon={<CheckCircle2 size={12} aria-hidden />}>
                      Pagada
                    </Chip>
                  )}
                  <div className="flex items-center gap-1">
                    <Link
                      href={`/panel/ventas/${sale.publicId}`}
                      className="inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-cuero outline-none hover:bg-tinta/5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cuero"
                    >
                      <Printer size={16} aria-hidden /> Recibo<span className="sr-only"> de {sale.clientName ?? "la venta"}</span>
                    </Link>
                    {sale.status === "paid" && !sale.voidRequested ? (
                      <Btn variant="ghost" size="sm" className="h-11" onPress={() => setSheet({ kind: "void", sale })}>
                        Pedir anulación<span className="sr-only"> de {sale.clientName ?? "la venta"} por {sale.totalLabel}</span>
                      </Btn>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Turno de caja: estado, conteo, gastos, propinas, consignaciones y cierre */}
      <h2 className="-mb-3 mt-2 text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">Turno de caja</h2>
      {s ? (
        <section aria-labelledby="turno" className={cx(card, "flex flex-col gap-5 p-5")}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h2 id="turno" className="flex items-center gap-2 font-display text-2xl leading-tight">
                {stale ? (
                  <>
                    <TriangleAlert size={20} className="text-alerta" aria-hidden /> Caja del {stale}
                  </>
                ) : (
                  <>
                    <LockOpen size={20} className="text-botella" aria-hidden /> Caja abierta
                  </>
                )}
              </h2>
              <p className="text-sm text-tinta/70">
                Desde las <span className="monto">{s.openedAtLabel}</span> · {s.openedBy}
              </p>
            </div>
          </div>

          {s.expectedLabel === null ? (
            <div className="flex items-start gap-3 rounded-xl border border-tinta/15 bg-hueso/60 p-4">
              <EyeOff size={20} className="mt-0.5 shrink-0 text-tinta/70" aria-hidden />
              <div className="flex flex-col gap-0.5 text-sm">
                <p className="font-semibold">Conteo a ciegas</p>
                <p className="text-tinta/80">El efectivo esperado se ve al cerrar la caja, después de contar. Así el conteo es tuyo y no se acomoda al número.</p>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-tinta p-4 text-hueso">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-hueso/70">Efectivo esperado ahora</p>
              <p className="monto font-display text-4xl leading-tight">{s.expectedLabel}</p>
            </div>
          )}

          {s.expectedLabel === null ? null : (
          <table className="w-full text-sm">
            <caption className="mb-2 text-left text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">Cómo se llega al esperado</caption>
            <tbody>
              {s.breakdown.map((b, i) => (
                <tr key={i} className="border-b border-tinta/10 last:border-b-0">
                  <th scope="row" className="py-2 text-left font-normal">
                    <span className="monto mr-2 inline-block w-4 text-center font-semibold" aria-hidden>
                      {b.sign === "-" ? "−" : b.sign === "+" ? "+" : ""}
                    </span>
                    {b.label}
                  </th>
                  <td className="monto py-2 text-right">
                    {/* En "±" el servidor ya manda el monto con su signo ("+$ 2.000"): se muestra tal cual. */}
                    <span className="sr-only">{b.sign === "+" ? "más " : b.sign === "-" ? "menos " : ""}</span>
                    {b.amountLabel}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-tinta/20">
                <th scope="row" className="py-2 text-left font-semibold">
                  = Efectivo esperado
                </th>
                <td className="monto py-2 text-right font-semibold">{s.expectedLabel}</td>
              </tr>
            </tfoot>
          </table>
          )}

          {s.byMethod.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">Otros medios del turno (no se cuentan)</h3>
              <ul className="flex flex-col divide-y divide-tinta/10 rounded-lg border border-tinta/10">
                {s.byMethod.map((m) => (
                  <li key={m.label} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>{m.label}</span>
                    <span className="monto font-semibold">{m.totalLabel}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <Btn variant="secondary" onPress={() => setSheet({ kind: "expense" })} isDisabled={view.dayClosed || !!stale}>
              <Receipt size={18} aria-hidden /> Registrar gasto
            </Btn>
            <Btn variant="secondary" onPress={() => setSheet({ kind: "tips" })} isDisabled={view.dayClosed || !!stale || view.tipsOwed.length === 0}>
              <HandCoins size={18} aria-hidden /> Pagar propinas
            </Btn>
            <Btn variant="secondary" onPress={() => setSheet({ kind: "deposit" })} isDisabled={view.dayClosed || !!stale}>
              <Landmark size={18} aria-hidden /> Consignar
            </Btn>
            <Btn onPress={startClose}>
              <Lock size={18} aria-hidden /> Cerrar caja
            </Btn>
          </div>
        </section>
      ) : (
        <section aria-labelledby="turno" className={cx(card, "flex flex-col gap-4 p-5")}>
          <div className="flex flex-col gap-1">
            <h2 id="turno" className="flex items-center gap-2 font-display text-2xl leading-tight">
              <Lock size={20} className="text-tinta/70" aria-hidden /> Caja cerrada
            </h2>
            <p className="text-sm text-tinta/70">
              {view.dayClosed
                ? "Con el día cerrado no se abre la caja."
                : "Ábrela contando la base para recibir efectivo. Sin caja abierta solo se cobra con tarjeta, transferencia o billetera."}
            </p>
          </div>
          {view.lastClosed ? (
            <dl className="grid grid-cols-2 gap-3 rounded-lg bg-hueso/50 p-3 text-sm">
              <div>
                <dt className="text-xs text-tinta/70">Último cierre</dt>
                <dd className="monto font-semibold">{view.lastClosed.closedAtLabel}</dd>
              </div>
              <div>
                <dt className="text-xs text-tinta/70">Contado</dt>
                <dd className="monto font-semibold">{view.lastClosed.countedLabel}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-tinta/70">Diferencia</dt>
                <dd className="monto font-semibold">{view.lastClosed.differenceLabel}</dd>
                {view.lastClosed.note ? <dd className="mt-0.5 text-tinta/80">{view.lastClosed.note}</dd> : null}
              </div>
            </dl>
          ) : null}
          <div className="flex flex-col gap-2 min-[400px]:flex-row">
            {view.canBankExpense ? (
              <Btn variant="secondary" size="lg" className="flex-1" onPress={() => setSheet({ kind: "expense" })} isDisabled={view.dayClosed}>
                <Receipt size={18} aria-hidden /> Gasto desde el banco
              </Btn>
            ) : null}
          </div>
        </section>
      )}

      {/* Movimientos */}
      {s ? (
        <section aria-labelledby="movimientos" className="flex flex-col gap-3">
          <h2 id="movimientos" className="font-display text-2xl leading-tight">
            Movimientos del turno
          </h2>
          {s.movements.length === 0 ? (
            <p className="text-sm text-tinta/70">Todavía no hay movimientos.</p>
          ) : (
            <ul className={cx(card, "divide-y divide-tinta/10")}>
              {s.movements.map((m, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-3">
                  {m.sign === "+" ? (
                    <ArrowDownLeft size={18} className="shrink-0 text-botella" aria-hidden />
                  ) : (
                    <ArrowUpRight size={18} className="shrink-0 text-alerta" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{m.description}</p>
                    <p className="text-xs text-tinta/70">
                      <span className="monto">{m.at}</span> · {MOVEMENT_LABEL[m.kind]}
                    </p>
                  </div>
                  {m.amountLabel === null ? (
                    <span className="shrink-0 text-xs text-tinta/70">{m.sign === "+" ? "Entra" : "Sale"}</span>
                  ) : (
                    <span className={cx("monto shrink-0 font-semibold", m.sign === "-" && "text-alerta")}>
                      <span className="sr-only">{m.sign === "+" ? "entra " : "sale "}</span>
                      {m.sign === "+" ? "+" : "−"} {m.amountLabel}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* Cierres con diferencia grande: el dueño los revisa */}
      {view.flaggedSessions.length > 0 ? <FlaggedSessions sessions={view.flaggedSessions} onReviewed={done} /> : null}

      {/* Día contable */}
      {view.canCloseDay || view.canReopenDay ? (
        <section aria-labelledby="dia" className={cx(card, "flex flex-col gap-3 p-5")}>
          <h2 id="dia" className="font-display text-2xl leading-tight">
            Día contable
          </h2>
          {view.pendingDay && view.canCloseDay ? (
            <div className="flex flex-col gap-2 rounded-xl border border-cuero/30 bg-cuero/5 p-4">
              <p className="text-sm">
                <span className="font-semibold">El {view.pendingDay.label} quedó sin cerrar.</span>{" "}
                {stale ? "Primero cierra la caja de ese día." : "Ciérralo para que nadie registre más movimientos en esa fecha."}
              </p>
              <Btn variant="secondary" className="self-start" isDisabled={!!stale} onPress={() => setSheet({ kind: "closePendingDay" })}>
                <CalendarCheck size={18} aria-hidden /> Cerrar el {view.pendingDay.label}
              </Btn>
            </div>
          ) : null}
          {view.dayClosed ? (
            <>
              <p className="text-sm text-tinta/80">El día {longDate(view.businessDate)} está cerrado: no acepta cobros ni movimientos.</p>
              {view.canReopenDay ? (
                <Btn variant="danger" className="self-start" onPress={() => setSheet({ kind: "reopen" })}>
                  <CalendarX size={18} aria-hidden /> Reabrir el día
                </Btn>
              ) : (
                <p className="text-sm text-tinta/70">Solo el dueño puede reabrirlo.</p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-tinta/80">
                Al cerrar el día no se aceptan más cobros ni movimientos en esta fecha.
                {s ? " Primero cierra la caja." : ""}
              </p>
              {view.canCloseDay ? (
                <Btn className="self-start" isDisabled={!!s} onPress={() => setSheet({ kind: "closeDay" })}>
                  <CalendarCheck size={18} aria-hidden /> Cerrar el día
                </Btn>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {/* Hojas */}
      <CheckoutSheet
        appointmentId={charging?.id ?? null}
        clientName={charging?.clientName}
        walkIn={walkIn && charging === null}
        onClose={(charged) => {
          setWalkIn(false);
          setCharging(null);
          if (charged) void refresh();
        }}
      />
      <Sheet isOpen={sheet?.kind === "open"} onOpenChange={(o) => !o && closeSheet()} title="Abrir caja" description="Cuenta el efectivo con el que empiezas.">
        <OpenForm view={view} onDone={done} onCancel={closeSheet} />
      </Sheet>
      <Sheet isOpen={sheet?.kind === "close"} onOpenChange={(o) => !o && closeSheet()} title="Cerrar caja" description="Cuenta el efectivo que hay en la caja.">
        {sheet?.kind === "close" ? (
          <CloseForm
            session={s}
            blind={view.blindCount}
            onClosed={() => void refresh()}
            onDone={done}
            onOpenToday={() => {
              toast("Caja cerrada");
              setSheet({ kind: "open" });
            }}
            onCancel={closeSheet}
          />
        ) : null}
      </Sheet>
      <Sheet isOpen={sheet?.kind === "expense"} onOpenChange={(o) => !o && closeSheet()} title="Registrar gasto">
        <ExpenseForm view={view} onDone={done} onCancel={closeSheet} />
      </Sheet>
      <Sheet isOpen={sheet?.kind === "tips"} onOpenChange={(o) => !o && closeSheet()} title="Pagar propinas" description="Sale efectivo de la caja para el barbero.">
        <TipsForm view={view} onDone={done} onCancel={closeSheet} />
      </Sheet>
      <Sheet isOpen={sheet?.kind === "deposit"} onOpenChange={(o) => !o && closeSheet()} title="Consignar al banco" description="El efectivo sale de la caja y entra al banco.">
        {s ? <DepositForm session={s} onDone={done} onCancel={closeSheet} /> : null}
      </Sheet>
      <Sheet isOpen={sheet?.kind === "void"} onOpenChange={(o) => !o && closeSheet()} title="Solicitar anulación" description="El dueño revisa la solicitud y la aprueba o la rechaza.">
        {sheet?.kind === "void" ? <VoidRequestForm sale={sheet.sale} onDone={done} onCancel={closeSheet} /> : null}
      </Sheet>
      <Sheet isOpen={sheet?.kind === "closeDay"} onOpenChange={(o) => !o && closeSheet()} title="¿Cerrar el día?">
        <CloseDayForm businessDate={view.businessDate} isToday onDone={done} onCancel={closeSheet} />
      </Sheet>
      <Sheet isOpen={sheet?.kind === "closePendingDay"} onOpenChange={(o) => !o && closeSheet()} title="¿Cerrar ese día?">
        {view.pendingDay ? <CloseDayForm businessDate={view.pendingDay.date} onDone={done} onCancel={closeSheet} /> : null}
      </Sheet>
      <Sheet isOpen={sheet?.kind === "reopen"} onOpenChange={(o) => !o && closeSheet()} title="Reabrir el día" description="Queda registrado con tu nombre, la hora y el motivo.">
        <ReopenDayForm businessDate={view.businessDate} onDone={done} onCancel={closeSheet} />
      </Sheet>
    </>
  );
}

// ─── Piezas de formulario ────────────────────────────────────────────────────

function Actions({ pending, onCancel, children, variant = "primary" }: { pending: boolean; onCancel: () => void; children: ReactNode; variant?: "primary" | "success" | "danger" }) {
  return (
    <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
      <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
        Cancelar
      </Btn>
      <Btn type="submit" variant={variant} isPending={pending}>
        {children}
      </Btn>
    </div>
  );
}

function NoteField({
  name = "note",
  label,
  value,
  onChange,
  error,
  isRequired,
  description,
}: {
  name?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  isRequired?: boolean;
  description?: string;
}) {
  return (
    <TextField name={name} value={value} onChange={onChange} isRequired={isRequired} isInvalid={!!error} maxLength={300} className={field.root}>
      <Label className={field.label}>{label}</Label>
      <TextArea className={cx(field.input, "h-20 py-2")} />
      {description ? <p className={field.description}>{description}</p> : null}
      <FieldMessage>{error}</FieldMessage>
    </TextField>
  );
}

/** Diferencia contado − esperado, dicha con texto e ícono (no solo color). */
function DifferencePreview({ diff, expectedLabel }: { diff: bigint; expectedLabel: string }) {
  const tone = diff === 0n ? "ok" : diff > 0n ? "over" : "short";
  return (
    <div
      aria-live="polite"
      className={cx(
        "flex items-start gap-3 rounded-xl border p-3 text-sm",
        tone === "ok" ? "border-botella/25 bg-botella/10" : "border-alerta/30 bg-alerta/5",
      )}
    >
      {tone === "ok" ? <CheckCircle2 size={20} className="shrink-0 text-botella" aria-hidden /> : <TriangleAlert size={20} className="shrink-0 text-alerta" aria-hidden />}
      <div className="flex flex-col gap-0.5">
        <p className="font-semibold">
          {tone === "ok" ? "Cuadra" : tone === "over" ? "Sobran " : "Faltan "}
          {tone !== "ok" ? <span className="monto">{fmt(diff > 0n ? diff : -diff)}</span> : null}
        </p>
        <p className="text-tinta/70">
          Esperado: <span className="monto">{expectedLabel}</span>
          {tone !== "ok" ? ". Explica la diferencia en la nota." : ""}
        </p>
      </div>
    </div>
  );
}

const noteError = (message: string) => message.startsWith("Escribe una nota");
// Exacto para el dueño; genérico para quien cuenta a ciegas (src/db/cash.ts, cashShortError).
const cashShort = (message: string) => message.startsWith("No hay tanto efectivo en la caja") || message.startsWith("Ese monto no se puede sacar de la caja");

// ─── Abrir ───────────────────────────────────────────────────────────────────

function OpenForm({ view, onDone, onCancel }: { view: CashView; onDone: (m: string) => void; onCancel: () => void }) {
  const run = useKeyedAction();
  const invalid = useFieldErrors<"counted" | "note">();
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const diff = counted && view.expectedOpeningMinor !== null ? unitsOf(counted) * PESO - big(view.expectedOpeningMinor) : 0n;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    if (!invalid.check(form, { ...(!counted ? { counted: "Escribe cuánto contaste (0 si no hay base)." } : {}), ...(diff !== 0n && !note.trim() ? { note: "Escribe una nota que explique la diferencia." } : {}) })) return;
    setPending(true);
    const r = await run((idempotencyKey) => openCashSessionAction({ countedUnits: counted, note: note.trim() || undefined, idempotencyKey }));
    setPending(false);
    if (r.ok) return onDone(r.data.differenceLabel ? `Caja abierta. Se registró la diferencia: ${r.data.differenceLabel}` : "Caja abierta");
    if (noteError(r.error)) invalid.check(form, { note: r.error });
    else setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <MoneyField
        name="counted"
        label="Base contada"
        value={counted}
        onChange={(v) => (setCounted(v), invalid.clear("counted"))}
        error={invalid.errors.counted}
        isRequired
        autoFocus
        size="lg"
      />
      {counted && view.expectedOpeningLabel !== null ? <DifferencePreview diff={diff} expectedLabel={view.expectedOpeningLabel} /> : null}
      <NoteField
        label={diff !== 0n ? "Nota (obligatoria)" : "Nota (opcional)"}
        value={note}
        onChange={(v) => (setNote(v), invalid.clear("note"))}
        error={invalid.errors.note}
        isRequired={diff !== 0n}
      />
      <FormError message={error} />
      <Actions pending={pending} onCancel={onCancel} variant="success">
        <LockOpen size={18} aria-hidden /> Abrir caja
      </Actions>
    </Form>
  );
}

// ─── Cerrar ──────────────────────────────────────────────────────────────────

/** Billetes y monedas de Colombia, en pesos. */
const DENOMINATIONS = [
  { units: 100_000n, kind: "Billete" },
  { units: 50_000n, kind: "Billete" },
  { units: 20_000n, kind: "Billete" },
  { units: 10_000n, kind: "Billete" },
  { units: 5_000n, kind: "Billete" },
  { units: 2_000n, kind: "Billete" },
  { units: 1_000n, kind: "Moneda" },
  { units: 500n, kind: "Moneda" },
  { units: 200n, kind: "Moneda" },
  { units: 100n, kind: "Moneda" },
  { units: 50n, kind: "Moneda" },
] as const;

function CloseForm({
  session: liveSession,
  blind,
  onClosed,
  onDone,
  onOpenToday,
  onCancel,
}: {
  session: Session | null;
  /** Conteo a ciegas: sin esperado ni diferencia hasta cerrar, y la nota siempre se pide. */
  blind: boolean;
  onClosed: () => void;
  onDone: (m: string) => void;
  /** Tras cerrar tarde la caja de otro día: pasa directo a abrir la de hoy. */
  onOpenToday: () => void;
  onCancel: () => void;
}) {
  // Al cerrar, la vista se refresca y la sesión desaparece: se conserva la última para el resumen.
  const last = useRef(liveSession);
  if (liveSession) last.current = liveSession;
  const session = last.current;
  const run = useKeyedAction();
  const [summary, setSummary] = useState<{ expectedLabel: string; countedLabel: string; differenceLabel: string; needsReview: boolean } | null>(null);
  const summaryRef = useRef<HTMLHeadingElement>(null);
  const invalid = useFieldErrors<"counted" | "note">();
  const [mode, setMode] = useState<"total" | "denominations">("total");
  const [total, setTotal] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Suma por denominación con BigInt: cantidad × valor, en pesos.
  const denomUnits = DENOMINATIONS.reduce((a, d) => a + unitsOf(counts[d.units.toString()] ?? "") * d.units, 0n);
  const hasDenoms = Object.values(counts).some((c) => c !== "");
  const countedUnits = mode === "total" ? (total ? unitsOf(total) : null) : hasDenoms ? denomUnits : null;
  const diff = countedUnits === null || !session || session.expectedMinor === null ? 0n : countedUnits * PESO - big(session.expectedMinor);
  const noteRequired = blind || diff !== 0n;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    if (
      !invalid.check(form, {
        ...(countedUnits === null ? { counted: mode === "total" ? "Escribe cuánto contaste." : "Cuenta al menos una denominación." } : {}),
        ...(countedUnits !== null && noteRequired && !note.trim()
          ? { note: blind ? "Escribe una nota del conteo (en el conteo a ciegas siempre se pide)." : "Escribe una nota que explique la diferencia." }
          : {}),
      })
    ) {
      if (mode === "denominations" && countedUnits === null) setError("Cuenta al menos una denominación.");
      return;
    }
    setPending(true);
    const r = await run((idempotencyKey) =>
      closeCashSessionAction({ countedUnits: (countedUnits ?? 0n).toString(), note: note.trim() || undefined, idempotencyKey }),
    );
    setPending(false);
    if (r.ok) {
      setSummary(r.data);
      onClosed();
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    if (noteError(r.error)) invalid.check(form, { note: r.error });
    else setError(r.error);
  }

  if (summary) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-2 text-center" role="status">
          <CheckCircle2 size={36} className="text-botella" aria-hidden />
          <h3 ref={summaryRef} tabIndex={-1} className="font-display text-2xl outline-none">
            {session?.staleDayLabel ? `Caja del ${session.staleDayLabel} cerrada` : "Caja cerrada"}
          </h3>
        </div>
        <dl className="flex flex-col gap-2 rounded-xl border border-tinta/10 bg-hueso/40 p-4 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-tinta/70">Esperado</dt>
            <dd className="monto font-semibold">{summary.expectedLabel}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-tinta/70">Contado</dt>
            <dd className="monto font-semibold">{summary.countedLabel}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 border-t border-tinta/10 pt-2">
            <dt className="font-semibold">Diferencia</dt>
            <dd className="monto text-lg font-semibold">{summary.differenceLabel}</dd>
          </div>
        </dl>
        {summary.needsReview ? (
          <p className="flex items-start gap-2 rounded-xl border border-alerta/30 bg-alerta/5 p-3 text-sm">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-alerta" aria-hidden />
            La diferencia supera el límite de la sede: el dueño revisará este cierre.
          </p>
        ) : null}
        {session?.staleDayLabel ? (
          <>
            <p className="text-sm text-tinta/80">El cierre quedó en el {session.staleDayLabel}. Ahora abre la caja de hoy contando la base.</p>
            <Btn size="lg" onPress={onOpenToday}>
              <LockOpen size={18} aria-hidden /> Abrir la caja de hoy
            </Btn>
            <Btn variant="ghost" onPress={() => onDone("Caja cerrada")}>
              Después
            </Btn>
          </>
        ) : (
          <Btn size="lg" onPress={() => onDone("Caja cerrada")}>
            Listo
          </Btn>
        )}
      </div>
    );
  }

  if (!session) return null;

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <RadioGroup value={mode} onChange={(v) => setMode(v as typeof mode)} className={field.root}>
        <Label className={field.label}>Cómo vas a contar</Label>
        <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
          <Radio value="total" className={cx(radioCard, "group")}>
            <RadioDot /> Total directo
          </Radio>
          <Radio value="denominations" className={cx(radioCard, "group")}>
            <RadioDot /> Billetes y monedas
          </Radio>
        </div>
      </RadioGroup>

      {mode === "total" ? (
        <MoneyField
          name="counted"
          label="Efectivo contado"
          value={total}
          onChange={(v) => (setTotal(v), invalid.clear("counted"))}
          error={invalid.errors.counted}
          isRequired
          size="lg"
        />
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className={cx(field.label, "mb-2")}>Cantidad de cada uno</legend>
          <div className="grid grid-cols-2 gap-2">
            {DENOMINATIONS.map((d, i) => {
              const k = d.units.toString();
              return (
                <TextField
                  key={k}
                  name={i === 0 ? "counted" : undefined}
                  value={counts[k] ?? ""}
                  onChange={(v) => {
                    setCounts((c) => ({ ...c, [k]: onlyDigits(v, 5) }));
                    invalid.clear("counted");
                  }}
                  inputMode="numeric"
                  className="flex flex-col gap-1"
                >
                  <Label className="text-xs font-semibold">
                    {d.kind} de <span className="monto">{fmt(d.units * PESO)}</span>
                  </Label>
                  <Input className={cx(field.input, "monto h-11 text-right")} placeholder="0" autoComplete="off" />
                </TextField>
              );
            })}
          </div>
          <p className="flex items-baseline justify-between rounded-lg bg-hueso/60 px-3 py-2">
            <span className="text-sm font-semibold">Total contado</span>
            <span className="monto text-xl font-semibold" aria-live="polite">
              {fmt(denomUnits * PESO)}
            </span>
          </p>
        </fieldset>
      )}

      {countedUnits !== null && session.expectedLabel !== null ? <DifferencePreview diff={diff} expectedLabel={session.expectedLabel} /> : null}
      <NoteField
        label={noteRequired ? "Nota (obligatoria)" : "Nota (opcional)"}
        value={note}
        onChange={(v) => (setNote(v), invalid.clear("note"))}
        error={invalid.errors.note}
        isRequired={noteRequired}
        description={
          blind
            ? "Cuenta sin mirar el esperado: lo verás, con la diferencia, al cerrar. Anota lo que el dueño deba saber (vueltos pendientes, billetes dudosos…)."
            : "El esperado puede cambiar si entra un cobro mientras cuentas; el servidor usa el valor exacto al cerrar."
        }
      />
      <FormError message={error} />
      <Actions pending={pending} onCancel={onCancel}>
        <Lock size={18} aria-hidden /> Cerrar caja
      </Actions>
    </Form>
  );
}

// ─── Gasto ───────────────────────────────────────────────────────────────────

function ExpenseForm({ view, onDone, onCancel }: { view: CashView; onDone: (m: string) => void; onCancel: () => void }) {
  const run = useKeyedAction();
  // Un gasto de banco pide confirmar identidad (el servidor decide); el reintento usa la misma clave.
  const reauth = useReauth({ description: "Un gasto pagado del banco cambia las cuentas sin pasar por la caja." });
  const invalid = useFieldErrors<"category" | "amount" | "description">();
  const cashOk = view.session !== null && view.session.staleDayLabel === null;
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [paidFrom, setPaidFrom] = useState<"cash" | "bank">(cashOk ? "cash" : "bank");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    if (
      !invalid.check(form, {
        ...(!categoryId ? { category: "Elige la categoría." } : {}),
        ...(unitsOf(amount) === 0n ? { amount: "Escribe el valor del gasto." } : {}),
        ...(description.trim().length < 3 ? { description: "Describe el gasto (al menos 3 letras)." } : {}),
      })
    )
      return;
    setPending(true);
    const r = await run((idempotencyKey) =>
      reauth.run(() => addExpenseAction({ categoryId: categoryId!, amountUnits: amount, paidFrom, description: description.trim(), idempotencyKey })),
    );
    setPending(false);
    if (r.ok) return onDone(paidFrom === "cash" ? "Gasto registrado: salió de la caja" : "Gasto registrado: salió del banco");
    if (cashShort(r.error)) invalid.check(form, { amount: r.error });
    else setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <SelectField
        name="category"
        label="Categoría"
        options={view.categories.map((c) => ({ id: c.id, label: c.name }))}
        value={categoryId}
        onChange={(v) => (setCategoryId(v), invalid.clear("category"))}
        error={invalid.errors.category}
        isRequired
      />
      <MoneyField name="amount" label="Valor" value={amount} onChange={(v) => (setAmount(v), invalid.clear("amount"))} error={invalid.errors.amount} isRequired />
      {view.canBankExpense ? (
        <RadioGroup value={paidFrom} onChange={(v) => setPaidFrom(v as "cash" | "bank")} className={field.root}>
          <Label className={field.label}>Sale de</Label>
          <div className="grid grid-cols-2 gap-2">
            <Radio value="cash" isDisabled={!cashOk} className={cx(radioCard, "group data-[disabled]:cursor-default data-[disabled]:opacity-60")}>
              <RadioDot />
              <span className="flex flex-col">
                <span className="inline-flex items-center gap-1.5">
                  <Wallet size={16} aria-hidden /> Caja
                </span>
                {!cashOk ? <span className="text-xs font-normal text-tinta/70">Caja cerrada</span> : null}
              </span>
            </Radio>
            <Radio value="bank" className={cx(radioCard, "group")}>
              <RadioDot />
              <span className="inline-flex items-center gap-1.5">
                <Landmark size={16} aria-hidden /> Banco
              </span>
            </Radio>
          </div>
        </RadioGroup>
      ) : (
        <p className="flex items-center gap-2 text-sm text-tinta/70">
          <Wallet size={16} aria-hidden /> Sale del efectivo de la caja.
        </p>
      )}
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
        <Input className={field.input} placeholder="Jabón y toallas" autoComplete="off" />
        <FieldMessage>{invalid.errors.description}</FieldMessage>
      </TextField>
      <FormError message={error} />
      <Actions pending={pending} onCancel={onCancel}>
        <Receipt size={18} aria-hidden /> Registrar gasto
      </Actions>
      {reauth.dialog}
    </Form>
  );
}

// ─── Propinas ────────────────────────────────────────────────────────────────

function TipsForm({ view, onDone, onCancel }: { view: CashView; onDone: (m: string) => void; onCancel: () => void }) {
  const run = useKeyedAction();
  const invalid = useFieldErrors<"staff" | "amount">();
  const first = view.tipsOwed[0];
  const owedUnits = (minor: string) => (big(minor) / PESO).toString();
  const [staffId, setStaffId] = useState<string | null>(first?.staffId ?? null);
  const [amount, setAmount] = useState(first ? owedUnits(first.owedMinor) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selected = view.tipsOwed.find((t) => t.staffId === staffId);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    if (
      !invalid.check(form, {
        ...(!staffId ? { staff: "Elige a quién le pagas." } : {}),
        ...(unitsOf(amount) === 0n ? { amount: "Escribe cuánto le pagas." } : {}),
        ...(selected && unitsOf(amount) * PESO > big(selected.owedMinor) ? { amount: `No puede ser más de lo que se le debe (${selected.owedLabel}).` } : {}),
      })
    )
      return;
    setPending(true);
    const r = await run((idempotencyKey) => payTipsAction({ staffId: staffId!, amountUnits: amount, idempotencyKey }));
    setPending(false);
    if (r.ok) return onDone(`Propinas pagadas a ${selected?.name ?? "el barbero"}`);
    if (cashShort(r.error)) invalid.check(form, { amount: r.error });
    else setError(r.error);
  }

  if (view.tipsOwed.length === 0) return <p className="text-sm text-tinta/70">No hay propinas por pagar.</p>;

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <SelectField
        name="staff"
        label="Barbero"
        options={view.tipsOwed.map((t) => ({ id: t.staffId, label: t.name, description: `Se le debe ${t.owedLabel}` }))}
        value={staffId}
        onChange={(v) => {
          setStaffId(v);
          const t = view.tipsOwed.find((x) => x.staffId === v);
          if (t) setAmount(owedUnits(t.owedMinor));
          invalid.clear("staff");
        }}
        error={invalid.errors.staff}
        isRequired
      />
      <MoneyField
        name="amount"
        label="Valor a pagar"
        value={amount}
        onChange={(v) => (setAmount(v), invalid.clear("amount"))}
        error={invalid.errors.amount}
        description={selected ? <>Se le debe <span className="monto">{selected.owedLabel}</span>. En efectivo, en pesos enteros.</> : undefined}
        isRequired
      />
      <FormError message={error} />
      <Actions pending={pending} onCancel={onCancel}>
        <HandCoins size={18} aria-hidden /> Pagar propinas
      </Actions>
    </Form>
  );
}

// ─── Consignación ────────────────────────────────────────────────────────────

function DepositForm({ session, onDone, onCancel }: { session: Session; onDone: (m: string) => void; onCancel: () => void }) {
  const run = useKeyedAction();
  const invalid = useFieldErrors<"amount">();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    if (!invalid.check(form, unitsOf(amount) === 0n ? { amount: "Escribe cuánto consignas." } : {})) return;
    setPending(true);
    const r = await run((idempotencyKey) => cashDepositAction({ amountUnits: amount, idempotencyKey }));
    setPending(false);
    if (r.ok) return onDone("Consignación registrada");
    if (cashShort(r.error)) invalid.check(form, { amount: r.error });
    else setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <MoneyField
        name="amount"
        label="Valor consignado"
        value={amount}
        onChange={(v) => (setAmount(v), invalid.clear("amount"))}
        error={invalid.errors.amount}
        description={<>En la caja se esperan <span className="monto">{session.expectedLabel}</span>.</>}
        isRequired
        autoFocus
      />
      <FormError message={error} />
      <Actions pending={pending} onCancel={onCancel}>
        <Landmark size={18} aria-hidden /> Consignar
      </Actions>
    </Form>
  );
}

// ─── Anulación ───────────────────────────────────────────────────────────────

function VoidRequestForm({ sale, onDone, onCancel }: { sale: DaySale; onDone: (m: string) => void; onCancel: () => void }) {
  const run = useKeyedAction();
  const invalid = useFieldErrors<"reason">();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!invalid.check(e.currentTarget, reason.trim().length < 5 ? { reason: "Explica el motivo (al menos 5 letras)." } : {})) return;
    setPending(true);
    const r = await run((idempotencyKey) => requestVoidAction({ saleId: sale.saleId, reason: reason.trim(), idempotencyKey }));
    setPending(false);
    if (r.ok) return onDone("Anulación solicitada. El dueño la revisa en Anulaciones.");
    setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 rounded-xl border border-tinta/10 bg-hueso/40 p-4 text-sm">
        <div>
          <dt className="text-xs text-tinta/70">Cliente</dt>
          <dd className="font-semibold">{sale.clientName ?? "Sin nombre"}</dd>
        </div>
        <div>
          <dt className="text-xs text-tinta/70">Total</dt>
          <dd className="monto font-semibold">{sale.totalLabel}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-tinta/70">Cobrada</dt>
          <dd>
            <span className="monto">{sale.atLabel}</span> · {sale.chargedBy}
          </dd>
        </div>
      </dl>
      <NoteField name="reason" label="Motivo" value={reason} onChange={(v) => (setReason(v), invalid.clear("reason"))} error={invalid.errors.reason} isRequired />
      <FormError message={error} />
      <Actions pending={pending} onCancel={onCancel}>
        Enviar solicitud
      </Actions>
    </Form>
  );
}

// ─── Día contable ────────────────────────────────────────────────────────────

function CloseDayForm({
  businessDate,
  isToday = false,
  onDone,
  onCancel,
}: {
  businessDate: string;
  /** Cerrar el día de HOY deja a la sede sin cobrar ni abrir caja el resto del día: se advierte. */
  isToday?: boolean;
  onDone: (m: string) => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const r = await callAction(() => closeDayAction({ businessDate }));
    setPending(false);
    if (r.ok) return onDone("Día cerrado");
    setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} className="flex flex-col gap-4">
      <p className="text-sm text-tinta/80">
        {longDate(businessDate)} queda cerrado: no se aceptan más cobros, gastos ni movimientos en esta fecha. Solo el dueño puede reabrirlo.
      </p>
      {isToday ? (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-alerta/30 bg-alerta/5 p-3 text-sm">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-alerta" aria-hidden />
          <span>
            Es el día de <strong>hoy</strong>. Ciérralo solo al terminar la jornada: después nadie podrá abrir la caja ni cobrar hoy. Para terminar un
            turno basta con cerrar la caja.
          </span>
        </p>
      ) : null}
      <FormError message={error} />
      <Actions pending={pending} onCancel={onCancel}>
        <CalendarCheck size={18} aria-hidden /> {isToday ? "Sí, terminó la jornada" : "Sí, cerrar el día"}
      </Actions>
    </Form>
  );
}

function ReopenDayForm({ businessDate, onDone, onCancel }: { businessDate: string; onDone: (m: string) => void; onCancel: () => void }) {
  const reauth = useReauth({ description: "Reabrir un día cerrado cambia las cuentas." });
  const invalid = useFieldErrors<"reason">();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!invalid.check(e.currentTarget, reason.trim().length < 5 ? { reason: "Explica el motivo (al menos 5 letras)." } : {})) return;
    setPending(true);
    const r = await callAction(() => reauth.run(() => reopenDayAction({ businessDate, reason: reason.trim() })));
    setPending(false);
    if (r.ok) return onDone("Día reabierto");
    setError(r.error);
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4">
      <p className="flex items-start gap-2 text-sm text-tinta/80">
        <Banknote size={18} className="mt-0.5 shrink-0" aria-hidden />
        {longDate(businessDate)} vuelve a aceptar movimientos hasta que se cierre otra vez.
      </p>
      <NoteField name="reason" label="Motivo" value={reason} onChange={(v) => (setReason(v), invalid.clear("reason"))} error={invalid.errors.reason} isRequired />
      <FormError message={error} />
      <Actions pending={pending} onCancel={onCancel} variant="danger">
        <CalendarX size={18} aria-hidden /> Reabrir el día
      </Actions>
      {reauth.dialog}
    </Form>
  );
}

// ─── Cierres por revisar (dueño) ─────────────────────────────────────────────

function FlaggedSessions({ sessions, onReviewed }: { sessions: CashView["flaggedSessions"]; onReviewed: (m: string) => void }) {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);

  async function review(id: string) {
    setPending(id);
    const r = await callAction(() => markCashSessionReviewedAction({ sessionId: id }));
    setPending(null);
    if (r.ok) onReviewed("Turno marcado como revisado");
    else toast(r.error, "error");
  }

  return (
    <section aria-labelledby="revisar" className="flex flex-col gap-3">
      <h2 id="revisar" className="flex items-center gap-2 font-display text-2xl leading-tight">
        <ShieldAlert size={20} className="text-alerta" aria-hidden /> Turnos por revisar
      </h2>
      <p className="text-sm text-tinta/80">La diferencia al abrir o al cerrar superó el límite de la sede (lo cambias en Ajustes).</p>
      <ul className={cx(card, "divide-y divide-tinta/10")}>
        {sessions.map((f) => (
          <li key={f.id} className="flex flex-col gap-3 px-4 py-3">
            {f.opening ? <ReviewPart title="Apertura" at={f.opening.atLabel} part={f.opening} /> : null}
            {f.closing?.flagged ? <ReviewPart title="Cierre" at={f.closing.atLabel} who={f.closing.closedBy} part={f.closing} /> : null}
            {f.open ? (
              <p className="text-sm text-tinta/70">El turno sigue abierto: lo revisas cuando se cierre.</p>
            ) : (
              <Btn
                variant="secondary"
                size="sm"
                className="h-11 self-start"
                isPending={pending === f.id}
                isDisabled={pending !== null && pending !== f.id}
                onPress={() => void review(f.id)}
              >
                <CheckCircle2 size={16} aria-hidden /> Marcar revisado<span className="sr-only"> el turno de {f.closing?.atLabel ?? f.opening?.atLabel}</span>
              </Btn>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReviewPart({
  title,
  at,
  who,
  part,
}: {
  title: string;
  at: string;
  who?: string;
  part: { expectedLabel: string; countedLabel: string; differenceLabel: string; note: string | null };
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="font-semibold">
          {title}: diferencia <span className="monto">{part.differenceLabel}</span>
        </p>
        <p className="text-xs text-tinta/70">
          <span className="monto">{at}</span>
          {who ? ` · Cerró ${who}` : ""}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-tinta/70">Libro</dt>
          <dd className="monto font-semibold">{part.expectedLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-tinta/70">Contado</dt>
          <dd className="monto font-semibold">{part.countedLabel}</dd>
        </div>
      </dl>
      {part.note ? <p className="text-sm text-tinta/80">{part.note}</p> : null}
    </div>
  );
}
