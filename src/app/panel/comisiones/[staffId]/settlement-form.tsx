"use client";

import { Banknote, ChevronDown, Info, Landmark, Plus, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Disclosure,
  DisclosurePanel,
  Form,
  Heading,
  Label,
  Radio,
  RadioGroup,
  Text,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "react-aria-components";
import { MAX_ADJUSTMENTS } from "@/domain/commissions/settlement";
import { DateField } from "../../_components/date-field";
import { dayShort, plural } from "../../_components/dates";
import { callAction, MoneyField, newKey } from "../../_components/money-field";
import { useReauth } from "../../_components/reauth";
import { Btn, cx, field, useToast } from "../../_components/ui";
import { card, FormError, RadioDot, radioCard } from "../../_manage/controls";
import { loadSettlementPreview, settleCommissionsAction } from "../actions";

// Liquidación de comisiones (docs/sprint-5-comisiones-informes.md §4 y §10). Cada cambio del
// formulario pide la vista previa al servidor, que calcula todo desde la base y devuelve un
// previewToken; el pago se confirma con ese token, así el dueño nunca paga un monto distinto del
// que vio. La interfaz no suma ni resta montos: solo muestra las etiquetas del servidor.

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
type PreviewInput = Parameters<typeof loadSettlementPreview>[0];
type Preview = OkData<Awaited<ReturnType<typeof loadSettlementPreview>>>;
type Adjustment = { id: number; direction: "add" | "deduct"; amount: string; reason: string };

const NOTHING_TO_SETTLE = "No hay nada que liquidar";
const STALE_ERRORS = ["La liquidación cambió", "Alguna de estas comisiones"];

export interface SettlementContext {
  staff: { id: string; name: string };
  businessDate: string;
  dayClosed: boolean;
  cashSessionOpen: boolean;
  lastCutoffDate: string | null;
  suggestedCutoffDate: string;
}

/** Arma la entrada de la vista previa, o dice qué falta. Solo texto: ningún monto pasa por number. */
function buildInput(
  ctx: SettlementContext,
  s: { cutoffDate: string; includeTips: boolean; deduction: "max" | "custom"; deductionUnits: string; adjustments: Adjustment[]; paidFrom: "cash" | "bank" },
): { input: PreviewInput | null; problem: string | null } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.cutoffDate)) return { input: null, problem: "Elige la fecha de corte." };
  if (s.deduction === "custom" && !/^\d+$/.test(s.deductionUnits)) return { input: null, problem: "Escribe cuánto descontar de los anticipos." };
  for (const a of s.adjustments) {
    if (!/^[1-9]\d*$/.test(a.amount)) return { input: null, problem: "Escribe el valor de cada ajuste." };
    if (a.reason.trim().length < 3) return { input: null, problem: "Escribe el motivo de cada ajuste (mínimo 3 letras)." };
  }
  return {
    problem: null,
    input: {
      staffId: ctx.staff.id,
      cutoffDate: s.cutoffDate,
      includeTips: s.includeTips,
      ...(s.deduction === "custom" ? { advanceDeductionUnits: s.deductionUnits } : {}),
      adjustments: s.adjustments.map((a) => ({ direction: a.direction, amountUnits: a.amount, reason: a.reason.trim() })),
      paidFrom: s.paidFrom,
    },
  };
}

export function SettlementForm({ ctx, refreshNonce }: { ctx: SettlementContext; refreshNonce: number }) {
  const router = useRouter();
  const toast = useToast();
  const reauth = useReauth({ description: "Liquidar comisiones saca dinero del negocio." });

  const [cutoffDate, setCutoffDate] = useState(ctx.suggestedCutoffDate);
  const [includeTips, setIncludeTips] = useState(true);
  const [deduction, setDeduction] = useState<"max" | "custom">("max");
  const [deductionUnits, setDeductionUnits] = useState("");
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [paidFrom, setPaidFrom] = useState<"cash" | "bank">(ctx.cashSessionOpen ? "cash" : "bank");
  const [note, setNote] = useState("");
  const nextAdj = useRef(1);

  const [preview, setPreview] = useState<{ key: string; data: Preview | null; error: string | null } | null>(null);
  /**
   * La última vista previa buena: se sigue mostrando (atenuada) mientras el formulario está a medias
   * o el servidor rechaza un valor, para que los campos que dependen de ella no desaparezcan. Pagar
   * solo se habilita con una vista previa de exactamente lo que está en pantalla (`data`).
   */
  const [shown, setShown] = useState<Preview | null>(null);
  const [settled, setSettled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef(newKey());

  const { input, problem } = useMemo(
    () => buildInput(ctx, { cutoffDate, includeTips, deduction, deductionUnits, adjustments, paidFrom }),
    [ctx, cutoffDate, includeTips, deduction, deductionUnits, adjustments, paidFrom],
  );
  const inputKey = input ? JSON.stringify(input) : null;

  // Vista previa del servidor, con una pausa corta para no pedirla en cada tecla.
  useEffect(() => {
    if (!inputKey) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      const r = await callAction(() => loadSettlementPreview(JSON.parse(inputKey) as PreviewInput));
      if (cancelled) return;
      setLoading(false);
      setPreview(r.ok ? { key: inputKey, data: r.data, error: null } : { key: inputKey, data: null, error: r.error });
      if (r.ok) setShown(r.data);
      else if (r.error.startsWith(NOTHING_TO_SETTLE)) setShown(null);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [inputKey, nonce, refreshNonce]);

  const data = preview?.key === inputKey ? preview.data : null;
  const fresh = !!data && !loading && !problem;
  // Una vista previa nueva es un intento nuevo: otra clave de idempotencia.
  const token = data?.previewToken;
  useEffect(() => {
    if (token) key.current = newKey();
  }, [token]);

  const payout = data?.totals.payoutMinor ?? null;
  const paysMoney = payout !== null && payout !== "0";
  const cashBlocked = !!data && paysMoney && paidFrom === "cash" && (!data.cash.sessionOpen || !data.cash.enough);
  const canPay = fresh && !ctx.dayClosed && !data.dayClosed && !cashBlocked && !pending && !settled;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!input || !data || !canPay) return;
    const previewToken = data.previewToken;
    setPending(true);
    const r = await callAction(() =>
      reauth.run(() =>
        settleCommissionsAction({ ...input, ...(note.trim() ? { note: note.trim() } : {}), previewToken, idempotencyKey: key.current }),
      ),
    );
    setPending(false);
    if (!("network" in r && r.network)) key.current = newKey();
    if (!r.ok) {
      setError(r.error);
      if (STALE_ERRORS.some((p) => r.error.startsWith(p))) setNonce((n) => n + 1);
      return;
    }
    setSettled(true);
    toast(`Liquidación ${r.data.numberLabel} registrada: ${r.data.payoutLabel}`);
    router.push(r.data.receiptHref);
  }

  const updateAdj = (id: number, patch: Partial<Adjustment>) => setAdjustments((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const nothing = preview?.key === inputKey && !!preview.error?.startsWith(NOTHING_TO_SETTLE);
  const previewError = preview?.key === inputKey && preview.error && !nothing ? preview.error : null;

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-6" aria-labelledby="liquidar">
      <div className="flex flex-col gap-1">
        <h2 id="liquidar" className="font-display text-2xl leading-tight">
          Liquidar
        </h2>
        <p className="text-sm text-tinta/70">Se paga todo lo pendiente hasta la fecha de corte. Revisa la vista previa antes de pagar.</p>
      </div>

      {ctx.dayClosed ? (
        <Notice tone="alert">El día de hoy ya está cerrado: no se puede liquidar hasta reabrirlo en Caja.</Notice>
      ) : null}

      <DateField
        label="Fecha de corte"
        value={cutoffDate}
        onChange={setCutoffDate}
        min={ctx.lastCutoffDate}
        max={ctx.businessDate}
        isRequired
        description={
          ctx.lastCutoffDate
            ? `Incluye lo cobrado hasta ese día. La última liquidación fue con corte al ${dayShort(ctx.lastCutoffDate)}.`
            : "Incluye lo cobrado hasta ese día. No puede ser una fecha futura."
        }
      />

      {/* Vista previa del servidor */}
      <section aria-labelledby="vista-previa" aria-busy={loading} className="flex flex-col gap-4">
        <h3 id="vista-previa" className="sr-only">
          Vista previa
        </h3>
        <p role="status" className="sr-only">
          {problem ?? (loading ? "Calculando la liquidación…" : data ? `Vista previa lista: pago de ${data.totals.payoutLabel}` : nothing ? preview?.error : "")}
        </p>

        {problem ? <Notice tone="info">{problem}</Notice> : null}
        {nothing ? <Notice tone="info">{preview?.error}</Notice> : null}
        <FormError message={previewError} />
        {!shown && loading && !problem ? <p className="text-sm text-tinta/70">Calculando la liquidación…</p> : null}

        {shown ? (
          <div className={cx("flex flex-col gap-4 transition-opacity", !fresh && "opacity-60")}>
            <CommissionLines data={shown} />

            {shown.waitingVoidDecision > 0 ? (
              <Notice tone="info">
                {shown.waitingVoidDecision === 1
                  ? "1 servicio espera una decisión de anulación: entra en la próxima liquidación si se rechaza."
                  : `${shown.waitingVoidDecision} servicios esperan una decisión de anulación: entran en la próxima liquidación si se rechaza.`}
              </Notice>
            ) : null}

            {shown.clawbacks.length > 0 ? (
              <div className={cx(card, "flex flex-col")}>
                <p className="border-b border-tinta/10 px-4 py-2.5 text-sm font-semibold">Anulaciones de ventas ya liquidadas</p>
                <ul className="divide-y divide-tinta/10">
                  {shown.clawbacks.map((c) => (
                    <li key={c.saleLineId} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{c.description}</span>
                        <span className="monto block text-xs text-tinta/70">
                          {dayShort(c.businessDate)}
                          {c.settlementNumberLabel ? ` · pagada en la liquidación ${c.settlementNumberLabel}` : ""}
                        </span>
                      </span>
                      <span className="monto shrink-0 whitespace-nowrap font-semibold text-alerta">−{c.amountLabel}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Propinas */}
      {shown && shown.tips.settledMinor !== "0" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className={cx(field.label, "mb-1.5")}>Propinas</legend>
          {shown.tips.mandatory ? (
            <Notice tone="info">
              Ya se le pagaron propinas de ventas que después se anularon. Saldo: <span className="monto whitespace-nowrap">{shown.tips.owedLabel}</span>. Se descuenta siempre.
            </Notice>
          ) : (
            <Checkbox isSelected={includeTips} onChange={setIncludeTips} className="group flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium outline-none">
              <span
                aria-hidden
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 border-tinta/50 group-data-[selected]:border-cuero group-data-[selected]:bg-cuero group-data-[focus-visible]:outline-3 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-cuero"
              >
                <svg viewBox="0 0 18 18" className="h-4 w-4 fill-none stroke-hueso stroke-[3] opacity-0 group-data-[selected]:opacity-100">
                  <polyline points="3 9.5 7 13.5 15 4.5" />
                </svg>
              </span>
              <span>
                Incluir propinas por pagar (<span className="monto whitespace-nowrap">{shown.tips.owedLabel}</span>)
              </span>
            </Checkbox>
          )}
          {shown.tips.included && shown.tips.settledMinor !== shown.tips.owedMinor ? (
            <p className="text-xs text-tinta/70">
              Se liquidan <span className="monto">{shown.tips.settledLabel}</span> en pesos enteros; los centavos quedan pendientes.
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {/* Anticipos */}
      {shown && shown.receivable.outstandingMinor !== "0" ? (
        <RadioGroup value={deduction} onChange={(v) => setDeduction(v as "max" | "custom")} className={field.root}>
          <Label className={field.label}>Descontar de anticipos</Label>
          <Text slot="description" className={field.description}>
            Debe <span className="monto">{shown.receivable.outstandingLabel}</span>. Lo que no se descuente queda para la próxima.
          </Text>
          <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
            <Radio value="max" className={cx(radioCard, "group")}>
              <RadioDot />
              <span>
                Lo máximo (<span className="monto whitespace-nowrap">{shown.receivable.maxDeductionLabel}</span>)
              </span>
            </Radio>
            <Radio value="custom" className={cx(radioCard, "group")}>
              <RadioDot />
              Otro valor
            </Radio>
          </div>
        </RadioGroup>
      ) : null}
      {deduction === "custom" && shown && shown.receivable.outstandingMinor !== "0" ? (
        <MoneyField
          label="Valor a descontar"
          value={deductionUnits}
          onChange={setDeductionUnits}
          description={`Máximo ${shown.receivable.maxDeductionLabel}.`}
        />
      ) : null}

      {/* Ajustes */}
      <fieldset className="flex flex-col gap-3">
        <legend className={cx(field.label, "mb-1.5")}>Ajustes</legend>
        {adjustments.length === 0 ? <p className="text-sm text-tinta/70">Bonos o descuentos, cada uno con su motivo. Salen en el comprobante.</p> : null}
        {adjustments.map((a, i) => (
          <div key={a.id} className={cx(card, "flex flex-col gap-3 p-3")} role="group" aria-label={`Ajuste ${i + 1}`}>
            <div className="flex items-center justify-between gap-2">
              <ToggleButtonGroup
                aria-label={`Tipo del ajuste ${i + 1}`}
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[a.direction]}
                onSelectionChange={(keys) => {
                  const k = [...keys][0];
                  if (k === "add" || k === "deduct") updateAdj(a.id, { direction: k });
                }}
                className="grid flex-1 grid-cols-2 gap-1 rounded-lg bg-tinta/5 p-1"
              >
                {(
                  [
                    ["add", "A favor"],
                    ["deduct", "En contra"],
                  ] as const
                ).map(([id, label]) => (
                  <ToggleButton
                    key={id}
                    id={id}
                    className={({ isSelected, isFocusVisible }) =>
                      cx(
                        "h-10 rounded-md text-sm font-semibold transition-colors",
                        isSelected ? "bg-papel text-tinta shadow-sm" : "text-tinta/70",
                        isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
                      )
                    }
                  >
                    {label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <Btn
                variant="ghost"
                size="sm"
                className="h-11 w-11 shrink-0 px-0 text-alerta"
                aria-label={`Quitar el ajuste ${i + 1}`}
                onPress={() => setAdjustments((list) => list.filter((x) => x.id !== a.id))}
              >
                <Trash2 size={18} aria-hidden />
              </Btn>
            </div>
            <MoneyField
              label={a.direction === "add" ? "Valor del bono" : "Valor del descuento"}
              value={a.amount}
              onChange={(v) => updateAdj(a.id, { amount: v })}
              isRequired
            />
            <TextField value={a.reason} onChange={(v) => updateAdj(a.id, { reason: v })} isRequired maxLength={300} className={field.root}>
              <Label className={field.label}>Motivo</Label>
              <TextArea className={cx(field.input, "h-16 py-2")} placeholder={a.direction === "add" ? "Ej.: bono por cubrir el domingo" : "Ej.: daño de la máquina"} />
            </TextField>
          </div>
        ))}
        {adjustments.length < MAX_ADJUSTMENTS ? (
          <Btn
            variant="secondary"
            className="self-start"
            onPress={() => setAdjustments((list) => [...list, { id: nextAdj.current++, direction: "add", amount: "", reason: "" }])}
          >
            <Plus size={18} aria-hidden /> Agregar ajuste
          </Btn>
        ) : (
          <p className="text-xs text-tinta/70">Máximo {MAX_ADJUSTMENTS} ajustes por liquidación.</p>
        )}
      </fieldset>

      {/* Origen del pago */}
      <RadioGroup value={paidFrom} onChange={(v) => setPaidFrom(v as "cash" | "bank")} className={field.root}>
        <Label className={field.label}>Se paga desde</Label>
        <div className="grid grid-cols-2 gap-2">
          <Radio value="cash" isDisabled={!ctx.cashSessionOpen} className={cx(radioCard, "group data-[disabled]:cursor-default data-[disabled]:opacity-50")}>
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
          {!ctx.cashSessionOpen ? (
            <>
              La caja está cerrada.{" "}
              <Link href="/panel/caja" className="font-semibold text-cuero underline underline-offset-2">
                Abre la caja
              </Link>{" "}
              para pagar en efectivo.
            </>
          ) : paysMoney ? (
            "El efectivo sale del turno abierto; del banco, de la cuenta del negocio."
          ) : (
            "Un pago de $ 0 no mueve dinero."
          )}
        </Text>
      </RadioGroup>
      {data && cashBlocked ? (
        <Notice tone="alert">
          {!data.cash.sessionOpen ? "Abre la caja para pagar en efectivo, o paga desde el banco." : "No hay tanto efectivo en la caja. Paga desde el banco o consigna primero."}
        </Notice>
      ) : null}

      <TextField value={note} onChange={setNote} maxLength={300} className={field.root}>
        <Label className={field.label}>Nota (opcional)</Label>
        <TextArea className={cx(field.input, "h-16 py-2")} />
        <Text slot="description" className={field.description}>
          Sale en el comprobante.
        </Text>
      </TextField>

      {shown ? (
        <div className={cx("transition-opacity", !fresh && "opacity-60")}>
          <Summary data={shown} />
        </div>
      ) : null}

      <FormError message={error} />

      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 border-t border-tinta/10 bg-papel/95 px-4 py-3 backdrop-blur lg:bottom-0 md:mx-0 md:rounded-xl md:border">
        <Btn type="submit" size="lg" className="w-full" isDisabled={!canPay} isPending={pending}>
          <ShieldCheck size={20} aria-hidden />
          {pending
            ? "Registrando…"
            : !data
              ? nothing
                ? "Nada que liquidar"
                : "Revisa la liquidación"
              : paysMoney
                ? `Pagar ${data.totals.payoutLabel} a ${ctx.staff.name}`
                : "Registrar liquidación sin pago"}
        </Btn>
        <p className="mt-1 text-center text-[11px] text-tinta/70">{loading ? "Actualizando la vista previa…" : "Pide confirmar tu identidad y abre el comprobante."}</p>
      </div>
      {reauth.dialog}
    </Form>
  );
}

function CommissionLines({ data }: { data: Preview }) {
  // Agrupa por día contable, en el orden en que llegan. Solo agrupa: no suma.
  const days: { date: string; lines: Preview["commissions"] }[] = [];
  for (const line of data.commissions) {
    const last = days[days.length - 1];
    if (last && last.date === line.businessDate) last.lines.push(line);
    else days.push({ date: line.businessDate, lines: [line] });
  }
  return (
    <div className={cx(card, "flex flex-col")}>
      <div className="flex items-end justify-between gap-3 px-4 py-3">
        <div className="flex flex-col">
          <span className="text-sm font-semibold">Comisiones pendientes</span>
          <span className="text-xs text-tinta/70">
            {plural(data.commissions.length, "servicio", "servicios")}
            {data.periodFromDate ? (
              <>
                {" "}
                · del <span className="monto">{dayShort(data.periodFromDate)}</span> al <span className="monto">{dayShort(data.cutoffDate)}</span>
              </>
            ) : null}
          </span>
        </div>
        <span className="monto shrink-0 whitespace-nowrap font-display text-2xl leading-tight">{data.totals.commissionLabel}</span>
      </div>
      {data.commissions.length > 0 ? (
        <Disclosure className="group border-t border-tinta/10">
          <Heading level={4}>
            <Button
              slot="trigger"
              className="flex min-h-11 w-full items-center justify-between gap-2 px-4 text-sm font-semibold text-cuero outline-none data-[focus-visible]:outline-3 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-cuero"
            >
              Ver el detalle por día
              <ChevronDown size={18} aria-hidden className="transition-transform group-data-[expanded]:rotate-180" />
            </Button>
          </Heading>
          <DisclosurePanel>
            <div className="flex flex-col pb-2">
              {days.map((d) => (
                <div key={d.date} className="flex flex-col">
                  <p className="bg-tinta/[0.04] px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-tinta/70">{dayShort(d.date)}</p>
                  <ul className="divide-y divide-tinta/10">
                    {d.lines.map((l) => (
                      <li key={l.saleLineId} className="flex items-start gap-3 px-4 py-2 text-sm">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{l.description}</span>
                          <span className="monto block text-xs text-tinta/70">
                            Neto {l.netLabel} · {l.rateLabel}
                          </span>
                        </span>
                        <span className="monto shrink-0 whitespace-nowrap font-semibold">{l.commissionLabel}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </DisclosurePanel>
        </Disclosure>
      ) : null}
    </div>
  );
}

function Summary({ data }: { data: Preview }) {
  const t = data.totals;
  const r = data.receivable;
  return (
    <table className={cx(card, "w-full border-separate border-spacing-0 overflow-hidden text-sm")}>
      <caption className="mb-2 text-left text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">Resumen de la liquidación</caption>
      <tbody>
        <Row label="Comisiones" value={t.commissionLabel} />
        {data.clawbacks.length > 0 ? <Row label="Anulaciones ya liquidadas" value={`−${t.clawbackLabel}`} negative /> : null}
        {data.tips.included || data.tips.mandatory ? <Row label="Propinas" value={t.tipsLabel} /> : null}
        {data.adjustments.length > 0 ? <Row label={`Ajustes (${data.adjustments.length})`} value={t.adjustmentsLabel} /> : null}
        <Row label="Ganado" value={t.grossLabel} strong />
        {r.deductionMinor !== "0" ? <Row label="Descuento de anticipos" value={`−${r.deductionLabel}`} negative /> : null}
        {t.carryOverMinor !== "0" ? <Row label="Queda debiendo (se descuenta en la próxima)" value={t.carryOverLabel} /> : null}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" className="border-t-2 border-tinta/20 px-4 py-3 text-left text-base font-semibold">
            Total a pagar
          </th>
          <td className="monto border-t-2 border-tinta/20 px-4 py-3 text-right font-display text-2xl">{t.payoutLabel}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function Row({ label, value, strong, negative }: { label: string; value: string; strong?: boolean; negative?: boolean }) {
  return (
    <tr>
      <th scope="row" className={cx("border-b border-tinta/10 px-4 py-2 text-left font-normal text-tinta/80", strong && "font-semibold text-tinta")}>
        {label}
      </th>
      <td className={cx("monto border-b border-tinta/10 px-4 py-2 text-right", strong && "font-semibold", negative && "text-alerta")}>{value}</td>
    </tr>
  );
}

function Notice({ tone, children }: { tone: "info" | "alert"; children: ReactNode }) {
  const Icon = tone === "alert" ? TriangleAlert : Info;
  return (
    <div
      className={cx(
        "flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm",
        tone === "alert" ? "border-alerta/30 bg-alerta/5 text-tinta" : "border-tinta/15 bg-papel text-tinta/80",
      )}
    >
      <Icon size={18} aria-hidden className={cx("mt-0.5 shrink-0", tone === "alert" ? "text-alerta" : "text-botella")} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

