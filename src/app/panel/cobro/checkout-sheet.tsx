"use client";

import { TZDate } from "@date-fns/tz";
import { format as formatDate } from "date-fns";
import { es } from "date-fns/locale";
import { Banknote, CheckCircle2, Lock, Percent, Plus, Receipt as ReceiptIcon, Share2, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Label, Radio, RadioGroup, TextField, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { CheckoutError, priceCheckout, type PaymentKind } from "@/domain/sales/checkout";
import { format, fromUnits, money, PESO, percentOf } from "@/domain/money";
import { FieldMessage, FormError } from "../_manage/controls";
import { callAction, MoneyField, newKey, NETWORK_ERROR, unitsOf } from "../_components/money-field";
import { SelectField } from "../_components/select-field";
import { Btn, cx, field, Sheet, useToast } from "../_components/ui";
import { longDate } from "../agenda/_components/slot-picker";
import { type ClientChoice, ClientPicker, clientIsReady } from "../agenda/_components/client-picker";
import { checkoutAction, loadCheckout, loadWalkInCheckout } from "./actions";

// Hoja de cobro (docs/sprint-4-cobro-caja.md §7 y §9). Caso típico en 3 toques: la cita → "Cobrar"
// → "Cobrar $X" (el medio ya viene elegido). Todo lo que se ve aquí es vista previa con las mismas
// funciones puras del dominio; lo que vale es lo que devuelve el servidor.

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
type CheckoutView = OkData<Awaited<ReturnType<typeof loadCheckout>>>;
type Receipt = OkData<Awaited<ReturnType<typeof checkoutAction>>>;
type Method = CheckoutView["methods"][number];

const SEDE_TZ = "America/Bogota";
const KIND_LABEL: Record<PaymentKind, string> = { cash: "Efectivo", card: "Tarjeta", transfer: "Transferencia", wallet: "Billetera" };
const TIP_CHOICES = [
  { id: "0", label: "0 %", bps: 0n },
  { id: "10", label: "10 %", bps: 1_000n },
  { id: "15", label: "15 %", bps: 1_500n },
  { id: "otro", label: "Otro", bps: null },
] as const;
type TipMode = (typeof TIP_CHOICES)[number]["id"];

/** Texto de centavos del servidor → bigint (0n si no es un entero). */
const big = (s: string) => (/^-?\d+$/.test(s) ? BigInt(s) : 0n);
const fmt = (minor: bigint) => format(money(minor));
const uid = () => newKey().slice(0, 8);

function paidAtLabel(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return formatDate(new TZDate(d, SEDE_TZ), "d 'de' MMMM, h:mm a", { locale: es });
}

// ─── Hoja ────────────────────────────────────────────────────────────────────

export function CheckoutSheet({
  appointmentId,
  walkIn = false,
  clientName,
  onClose,
}: {
  appointmentId: string | null;
  /** Cobro sin cita (walk-in): servicios, barbero y cliente (opcional) se eligen en la hoja. */
  walkIn?: boolean;
  clientName?: string | null;
  /** `charged`: si se registró un cobro (para refrescar la agenda). */
  onClose: (charged: boolean) => void;
}) {
  const charged = useRef(false);
  const isOpen = appointmentId !== null || walkIn;
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose(charged.current);
          charged.current = false;
        }
      }}
      title={appointmentId === null ? "Cobrar sin cita" : "Cobrar"}
      description={appointmentId === null ? "Elige los servicios y quién los hizo." : (clientName ?? undefined)}
    >
      {isOpen ? (
        <CheckoutLoader
          key={appointmentId ?? "walk-in"}
          appointmentId={appointmentId}
          onCharged={() => (charged.current = true)}
          onDone={() => {
            onClose(charged.current);
            charged.current = false;
          }}
        />
      ) : null}
    </Sheet>
  );
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; view: CheckoutView } | { status: "receipt"; receipt: Receipt };

function CheckoutLoader({ appointmentId, onCharged, onDone }: { appointmentId: string | null; onCharged: () => void; onDone: () => void }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let alive = true;
    callAction(() => (appointmentId === null ? loadWalkInCheckout() : loadCheckout({ appointmentId }))).then((r) => {
      if (!alive) return;
      setState(r.ok ? { status: "ready", view: r.data } : { status: "error", message: r.error });
    });
    return () => {
      alive = false;
    };
  }, [appointmentId, reloads]);

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <p className="sr-only" role="status">
          Cargando el cobro…
        </p>
        <div className="h-24 animate-pulse rounded-xl bg-tinta/5" />
        <div className="h-16 animate-pulse rounded-xl bg-tinta/5" />
        <div className="h-32 animate-pulse rounded-xl bg-tinta/5" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-4">
        <FormError message={state.message} />
        <Btn variant="secondary" onPress={() => (setState({ status: "loading" }), setReloads((n) => n + 1))}>
          Intentar de nuevo
        </Btn>
      </div>
    );
  }
  if (state.status === "receipt") return <ReceiptView receipt={state.receipt} onDone={onDone} />;
  if (state.view.paid) return <AlreadyPaid paid={state.view.paid} onDone={onDone} />;
  return (
    <CheckoutForm
      view={state.view}
      onPaid={(receipt) => {
        onCharged();
        setState({ status: "receipt", receipt });
      }}
      onReload={() => setReloads((n) => n + 1)}
    />
  );
}

function AlreadyPaid({ paid, onDone }: { paid: NonNullable<CheckoutView["paid"]>; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-xl border border-botella/25 bg-botella/10 p-4 text-botella" role="status">
        <CheckCircle2 size={22} className="mt-0.5 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-semibold">Esta cita ya está cobrada</p>
          <p className="text-sm text-tinta/80">
            Total <span className="monto font-semibold text-tinta">{paid.totalLabel}</span> · {paidAtLabel(paid.paidAt)}
          </p>
        </div>
      </div>
      <p className="text-sm text-tinta/70">Si hubo un error, pide la anulación desde Caja, en las ventas del día.</p>
      <div className="flex flex-col gap-2 min-[400px]:flex-row min-[400px]:justify-end">
        <Link
          href="/panel/caja"
          className="inline-flex h-11 items-center justify-center rounded-lg border border-tinta/20 bg-papel px-4 text-sm font-semibold hover:border-tinta/40"
        >
          Ir a Caja
        </Link>
        <Btn onPress={onDone}>Listo</Btn>
      </div>
    </div>
  );
}

// ─── Formulario ──────────────────────────────────────────────────────────────

interface Extra {
  uid: string;
  serviceId: string;
  staffId: string;
}
interface Discount {
  open: boolean;
  digits: string;
  reason: string;
}
interface Tip {
  mode: TipMode;
  digits: string;
}
interface PayRow {
  uid: string;
  methodId: string;
  digits: string;
  tendered: string;
}
interface UiLine {
  /** Clave en la interfaz: el `key` del servidor o `x:<uid>` para un extra. */
  uiKey: string;
  extraUid: string | null;
  name: string;
  staffId: string;
  staffName: string;
  unit: bigint;
  commissionBps: bigint;
}

type Errors = {
  summary?: string;
  payments?: string;
  discounts?: Record<string, string>;
  tendered?: Record<string, string>;
  tips?: Record<string, string>;
};

function CheckoutForm({ view, onPaid, onReload }: { view: CheckoutView; onPaid: (r: Receipt) => void; onReload: () => void }) {
  const [cashOpen, setCashOpen] = useState(view.cashSessionOpen);
  const [dayClosed, setDayClosed] = useState(view.dayClosed);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [discounts, setDiscounts] = useState<Record<string, Discount>>({});
  const [tips, setTips] = useState<Record<string, Tip>>({});
  const [extraTipStaff, setExtraTipStaff] = useState<string[]>([]);
  const walkIn = view.appointmentId === null;
  const [client, setClient] = useState<ClientChoice>({ kind: "none", name: "" });
  const usable = (m: Method) => m.kind !== "cash" || cashOpen;
  const defaultMethod = (view.methods.find((m) => m.kind === "cash" && cashOpen) ?? view.methods.find((m) => m.kind !== "cash"))?.id ?? "";
  const [split, setSplit] = useState(false);
  const [rows, setRows] = useState<PayRow[]>([{ uid: uid(), methodId: defaultMethod, digits: "", tendered: "" }]);
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  // Clave de idempotencia: se conserva entre reintentos de red y se renueva tras cualquier respuesta.
  const idempotencyKey = useRef(newKey());
  const summaryRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const methodById = (id: string) => view.methods.find((m) => m.id === id);
  const staffName = (id: string) => view.staff.find((s) => s.id === id)?.name ?? "";

  // Líneas: las de la cita y los extras.
  const lines: UiLine[] = useMemo(
    () => [
      ...view.lines.map((l) => ({
        uiKey: l.key,
        extraUid: null,
        name: l.serviceName,
        staffId: l.staffId,
        staffName: l.staffName,
        unit: big(l.unitPriceMinor),
        commissionBps: big(l.commissionBps),
      })),
      ...extras.flatMap((x) => {
        const s = view.extraServices.find((e) => e.serviceId === x.serviceId);
        if (!s) return [];
        return [
          {
            uiKey: `x:${x.uid}`,
            extraUid: x.uid,
            name: s.name,
            staffId: x.staffId,
            staffName: staffName(x.staffId),
            unit: big(s.unitPriceMinor),
            commissionBps: big(s.commissionBps),
          },
        ];
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, extras],
  );

  const maxBps = big(view.rules.maxDiscountBps);
  const discountMinor = (l: UiLine) => {
    const d = discounts[l.uiKey];
    return d?.open ? unitsOf(d.digits) * PESO : 0n;
  };
  /** Tope en pesos enteros: lo que pasa la comparación exacta descuento/precio ≤ tope. */
  const capMinor = (l: UiLine) => ((l.unit * maxBps) / (10_000n * PESO)) * PESO;
  const netOf = (l: UiLine) => {
    const n = l.unit - discountMinor(l);
    return n > 0n ? n : 0n;
  };

  const subtotal = lines.reduce((a, l) => a + l.unit, 0n);
  const netTotal = lines.reduce((a, l) => a + netOf(l), 0n);
  const discountTotal = subtotal - netTotal;

  // Propinas: una fila por barbero de las líneas, más las que se agreguen a mano.
  const tipStaff = [...new Set([...lines.map((l) => l.staffId), ...extraTipStaff])];
  const tipMinor = (staffId: string) => {
    const t = tips[staffId] ?? { mode: "0", digits: "" };
    if (t.mode === "otro") return unitsOf(t.digits) * PESO;
    const bps = TIP_CHOICES.find((c) => c.id === t.mode)?.bps ?? 0n;
    if (bps === 0n) return 0n;
    const own = lines.filter((l) => l.staffId === staffId).reduce((a, l) => a + netOf(l), 0n);
    // Porcentaje del neto, redondeado half-up al peso con money.ts (nunca con floats).
    return percentOf(money(own > 0n ? own : netTotal), bps, PESO).minor;
  };
  const tipsTotal = tipStaff.reduce((a, s) => a + tipMinor(s), 0n);
  const totalDue = netTotal + tipsTotal;

  const amountOf = (row: PayRow, i: number) => (split ? unitsOf(row.digits) * PESO : i === 0 ? totalDue : 0n);
  const activeRows = split ? rows : rows.slice(0, 1);
  const paid = activeRows.reduce((a, r, i) => a + amountOf(r, i), 0n);
  const remaining = totalDue - paid;
  const changeOf = (row: PayRow, i: number) => {
    if (methodById(row.methodId)?.kind !== "cash" || !row.tendered) return 0n;
    const c = unitsOf(row.tendered) * PESO - amountOf(row, i);
    return c > 0n ? c : 0n;
  };
  const change = activeRows.reduce((a, r, i) => a + changeOf(r, i), 0n);

  const blocked = dayClosed;

  function clearError(key: keyof Errors, sub?: string) {
    setErrors((e) => {
      if (!e[key]) return e;
      if (sub && typeof e[key] === "object") {
        const { [sub]: _gone, ...rest } = e[key] as Record<string, string>;
        return { ...e, [key]: rest };
      }
      return { ...e, [key]: undefined };
    });
  }

  function focusSoon(name: string | null) {
    requestAnimationFrame(() => {
      const el = name ? formRef.current?.querySelector<HTMLElement>(`[name="${name}"]`) : null;
      (el ?? summaryRef.current)?.focus();
    });
  }

  function patchRow(id: string, patch: Partial<PayRow>) {
    setRows((rs) => rs.map((r) => (r.uid === id ? { ...r, ...patch } : r)));
    clearError("payments");
    clearError("tendered", id);
  }

  /** Validación local (vista previa): los mismos mensajes que el servidor, en el campo que toca. */
  function validate(): { errors: Errors; focus: string | null } {
    const found: Errors = {};
    let focus: string | null = null;
    if (lines.length === 0) {
      found.summary = "Elige al menos un servicio.";
      return { errors: found, focus };
    }
    if (walkIn && client.kind === "new" && !clientIsReady(client, true)) {
      found.summary = "Completa el nombre y el celular del cliente nuevo, o quítalo (el cliente es opcional).";
      return { errors: found, focus };
    }
    const disc: Record<string, string> = {};
    for (const l of lines) {
      const d = discounts[l.uiKey];
      if (!d?.open || unitsOf(d.digits) === 0n) continue;
      if (discountMinor(l) > capMinor(l)) disc[l.uiKey] = `El descuento supera el tope: máximo ${fmt(capMinor(l))}.`;
      else if (!d.reason.trim()) disc[l.uiKey] = "Escribe el motivo del descuento.";
      if (disc[l.uiKey] && !focus) focus = disc[l.uiKey]!.startsWith("Escribe") ? `reason-${l.uiKey}` : `discount-${l.uiKey}`;
    }
    if (Object.keys(disc).length) found.discounts = disc;
    const tipErr: Record<string, string> = {};
    for (const s of tipStaff) {
      if (tips[s]?.mode === "otro" && !tips[s]?.digits) {
        tipErr[s] = "Escribe la propina o elige 0 %.";
        focus ??= `tip-${s}`;
      }
    }
    if (Object.keys(tipErr).length) found.tips = tipErr;
    if (activeRows.some((r) => !methodById(r.methodId))) {
      found.payments = "Elige cómo paga el cliente.";
    } else if (activeRows.some((r) => methodById(r.methodId)?.kind === "cash") && !cashOpen) {
      found.payments = "Abre la caja para recibir efectivo.";
    } else if (remaining > 0n) {
      found.payments = `Falta dinero por cobrar: ${fmt(remaining)}.`;
    } else if (remaining < 0n) {
      found.payments = `Los pagos superan el total por ${fmt(-remaining)}.`;
    }
    if (found.payments) focus ??= split ? `amount-${rows[0]?.uid}` : null;
    const tend: Record<string, string> = {};
    activeRows.forEach((r, i) => {
      if (methodById(r.methodId)?.kind === "cash" && r.tendered && unitsOf(r.tendered) * PESO < amountOf(r, i)) {
        tend[r.uid] = "El efectivo entregado no alcanza.";
        focus ??= `tendered-${r.uid}`;
      }
    });
    if (Object.keys(tend).length) found.tendered = tend;
    if (Object.keys(found).length === 0) {
      // Último filtro: la misma función pura del servidor (líneas, topes, pagos y propinas).
      try {
        priceCheckout(
          {
            lines: lines.map((l) => ({
              staffId: big(l.staffId),
              description: l.name,
              unitPrice: money(l.unit),
              discount: money(discountMinor(l)),
              discountReason: discounts[l.uiKey]?.reason,
              commissionBps: l.commissionBps,
            })),
            tips: tipStaff.filter((s) => tipMinor(s) > 0n).map((s) => ({ staffId: big(s), amount: money(tipMinor(s)) })),
            payments: activeRows.map((r, i) => {
              const m = methodById(r.methodId)!;
              return {
                methodId: big(m.id),
                kind: m.kind,
                amount: money(amountOf(r, i)),
                tendered: m.kind === "cash" && r.tendered ? fromUnits(unitsOf(r.tendered)) : undefined,
                feeBps: m.kind === "cash" ? 0n : big(m.feeBps),
              };
            }),
          },
          { commissionBase: view.rules.commissionBase, maxDiscountBps: maxBps, tipsBearCardFees: view.rules.tipsBearCardFees },
        );
      } catch (err) {
        found.summary = err instanceof CheckoutError ? err.message : "Revisa los datos del cobro.";
      }
    }
    return { errors: found, focus };
  }

  function applyServerError(message: string) {
    const starts = (p: string) => message.startsWith(p);
    if (starts("Esta cita ya está cobrada")) {
      setErrors({ summary: message });
      onReload();
      return;
    }
    if (starts("Abre la caja para recibir efectivo")) {
      setCashOpen(false);
      setErrors({ payments: message });
      focusSoon(null);
      return;
    }
    if (starts("El día ya está cerrado")) {
      setDayClosed(true);
      setErrors({ summary: message });
      focusSoon(null);
      return;
    }
    if (starts("Falta dinero por cobrar") || starts("Los pagos superan el total")) {
      setErrors({ payments: message });
      focusSoon(null);
      return;
    }
    if (starts("El efectivo entregado no alcanza")) {
      const cashRow = activeRows.find((r) => methodById(r.methodId)?.kind === "cash");
      if (cashRow) {
        setErrors({ tendered: { [cashRow.uid]: message } });
        focusSoon(`tendered-${cashRow.uid}`);
        return;
      }
    }
    if (starts("El descuento supera el tope") || starts("Escribe el motivo del descuento")) {
      const line = lines.find((l) => discounts[l.uiKey]?.open && unitsOf(discounts[l.uiKey]!.digits) > 0n);
      if (line) {
        const reasonField = starts("Escribe");
        setErrors({ discounts: { [line.uiKey]: message } });
        focusSoon(reasonField ? `reason-${line.uiKey}` : `discount-${line.uiKey}`);
        return;
      }
    }
    setErrors({ summary: message });
    focusSoon(null);
  }

  async function submit() {
    if (pending || blocked) return;
    const { errors: found, focus } = validate();
    setErrors(found);
    if (Object.keys(found).length) {
      focusSoon(focus);
      return;
    }
    const extraIndex = new Map(extras.map((x, i) => [x.uid, i]));
    const payload = {
      appointmentId: view.appointmentId,
      ...(walkIn
        ? {
            client:
              client.kind === "existing"
                ? { kind: "existing" as const, id: client.id }
                : client.kind === "new"
                  ? { kind: "new" as const, name: client.name, phone: client.phone }
                  : { kind: "none" as const },
          }
        : {}),
      extras: extras.map((x) => ({ serviceId: x.serviceId, staffId: x.staffId })),
      discounts: lines
        .filter((l) => discountMinor(l) > 0n)
        .map((l) => ({
          key: l.extraUid ? `extra:${extraIndex.get(l.extraUid)}` : l.uiKey,
          amountUnits: (discountMinor(l) / PESO).toString(),
          reason: discounts[l.uiKey]!.reason.trim(),
        })),
      tips: tipStaff.filter((s) => tipMinor(s) > 0n).map((s) => ({ staffId: s, amountUnits: (tipMinor(s) / PESO).toString() })),
      payments: activeRows.map((r, i) => {
        const cash = methodById(r.methodId)?.kind === "cash";
        return {
          methodId: r.methodId,
          amountUnits: (amountOf(r, i) / PESO).toString(),
          ...(cash && r.tendered ? { tenderedUnits: r.tendered } : {}),
        };
      }),
      idempotencyKey: idempotencyKey.current,
    };
    setPending(true);
    const res = await callAction(() => checkoutAction(payload));
    setPending(false);
    if (!res.ok && res.network) {
      setErrors({ summary: NETWORK_ERROR });
      focusSoon(null);
      return;
    }
    idempotencyKey.current = newKey();
    if (res.ok) onPaid(res.data);
    else applyServerError(res.error);
  }

  const unusedMethods = view.methods.filter((m) => usable(m) && !rows.some((r) => r.methodId === m.id));
  const cashMethod = view.methods.find((m) => m.kind === "cash");

  return (
    <div ref={formRef} className="flex flex-col gap-6">
      {blocked ? (
        <div className="flex items-start gap-3 rounded-xl border border-alerta/30 bg-alerta/5 p-4" role="status">
          <Lock size={20} className="mt-0.5 shrink-0 text-alerta" aria-hidden />
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-semibold text-alerta">El día contable está cerrado</p>
            <p className="text-tinta/80">
              {longDate(view.businessDate)}: no se pueden registrar cobros. El dueño puede reabrirlo desde{" "}
              <Link href="/panel/caja" className="font-semibold text-cuero underline underline-offset-4">
                Caja
              </Link>
              .
            </p>
          </div>
        </div>
      ) : null}

      {walkIn ? (
        <section aria-labelledby="cobro-cliente" className="flex flex-col gap-3">
          <h3 id="cobro-cliente" className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
            Cliente
          </h3>
          <ClientPicker value={client} onChange={setClient} optional />
        </section>
      ) : null}

      {/* Servicios */}
      <section aria-labelledby="cobro-servicios" className="flex flex-col gap-3">
        <h3 id="cobro-servicios" className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
          Servicios
        </h3>
        {lines.length === 0 ? <p className="text-sm text-tinta/70">Todavía no hay servicios: agrega el primero.</p> : null}
        <ul className={cx("flex flex-col divide-y divide-tinta/10 rounded-xl border border-tinta/10 bg-papel", lines.length === 0 && "hidden")}>
          {lines.map((l) => (
            <LineRow
              key={l.uiKey}
              line={l}
              net={netOf(l)}
              cap={capMinor(l)}
              maxBps={view.rules.maxDiscountBps}
              canDiscount={view.rules.canDiscount}
              discount={discounts[l.uiKey] ?? { open: false, digits: "", reason: "" }}
              error={errors.discounts?.[l.uiKey]}
              onDiscount={(d) => {
                setDiscounts((all) => ({ ...all, [l.uiKey]: d }));
                clearError("discounts", l.uiKey);
              }}
              onRemove={l.extraUid ? () => setExtras((xs) => xs.filter((x) => x.uid !== l.extraUid)) : undefined}
            />
          ))}
        </ul>
        {view.extraServices.length > 0 && lines.length < 20 ? (
          <AddExtra
            view={view}
            initiallyOpen={walkIn && lines.length === 0}
            defaultStaff={view.lines[0]?.staffId ?? extras[extras.length - 1]?.staffId ?? view.staff[0]?.id ?? ""}
            onAdd={(x) => {
              setExtras((xs) => [...xs, { ...x, uid: uid() }]);
              clearError("summary");
            }}
          />
        ) : null}
      </section>

      {/* Propinas */}
      <section aria-labelledby="cobro-propina" className="flex flex-col gap-3">
        <h3 id="cobro-propina" className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
          Propina
        </h3>
        {tipStaff.map((s) => (
          <TipRow
            key={s}
            staffId={s}
            name={staffName(s) || lines.find((l) => l.staffId === s)?.staffName || "Barbero"}
            tip={tips[s] ?? { mode: "0", digits: "" }}
            amount={tipMinor(s)}
            error={errors.tips?.[s]}
            onChange={(t) => {
              setTips((all) => ({ ...all, [s]: t }));
              clearError("tips", s);
            }}
            onRemove={extraTipStaff.includes(s) && !lines.some((l) => l.staffId === s) ? () => setExtraTipStaff((xs) => xs.filter((x) => x !== s)) : undefined}
          />
        ))}
        {view.staff.some((s) => !tipStaff.includes(s.id)) && tipStaff.length < 10 ? (
          <AddTipStaff
            options={view.staff.filter((s) => !tipStaff.includes(s.id))}
            onAdd={(id) => {
              setExtraTipStaff((xs) => [...xs, id]);
              setTips((all) => ({ ...all, [id]: { mode: "otro", digits: "" } }));
            }}
          />
        ) : null}
      </section>

      {/* Pago */}
      <section aria-labelledby="cobro-pago" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 id="cobro-pago" className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
            Pago
          </h3>
          {view.methods.filter(usable).length > 1 ? (
            <Btn
              variant="ghost"
              size="sm"
              className="h-11"
              onPress={() => {
                if (split) {
                  setRows((rs) => rs.slice(0, 1));
                  setSplit(false);
                } else {
                  setRows((rs) => [{ ...rs[0]!, digits: (totalDue / PESO).toString() }]);
                  setSplit(true);
                }
                clearError("payments");
              }}
            >
              {split ? "Un solo medio" : "Dividir el pago"}
            </Btn>
          ) : null}
        </div>

        {!cashOpen && cashMethod ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-tinta/10 bg-hueso/60 px-3 py-2 text-sm text-tinta/80">
            <Lock size={14} aria-hidden /> La caja está cerrada: no se recibe efectivo.
            <Link href="/panel/caja" className="inline-flex min-h-11 items-center font-semibold text-cuero underline underline-offset-4">
              Abrir caja
            </Link>
          </p>
        ) : null}

        {!split ? (
          <SinglePayment
            methods={view.methods}
            usable={usable}
            row={rows[0]!}
            amount={totalDue}
            change={changeOf(rows[0]!, 0)}
            tenderedError={errors.tendered?.[rows[0]!.uid]}
            onChange={(patch) => patchRow(rows[0]!.uid, patch)}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((r, i) => (
              <SplitRow
                key={r.uid}
                row={r}
                method={methodById(r.methodId)}
                amount={amountOf(r, i)}
                change={changeOf(r, i)}
                tenderedError={errors.tendered?.[r.uid]}
                onChange={(patch) => patchRow(r.uid, patch)}
                onRemove={
                  rows.length > 1
                    ? () => {
                        const rest = rows.filter((x) => x.uid !== r.uid);
                        setRows(rest);
                        if (rest.length === 1) setSplit(false);
                      }
                    : undefined
                }
              />
            ))}
            {remaining > 0n && unusedMethods.length > 0 && rows.length < 5 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-semibold">
                  Pagar el resto (<span className="monto">{fmt(remaining)}</span>) con…
                </p>
                <div className="flex flex-wrap gap-2">
                  {unusedMethods.map((m) => (
                    <Btn
                      key={m.id}
                      variant="secondary"
                      onPress={() => {
                        setRows((rs) => [...rs, { uid: uid(), methodId: m.id, digits: (remaining / PESO).toString(), tendered: "" }]);
                        clearError("payments");
                      }}
                    >
                      <Plus size={16} aria-hidden /> {m.label}
                    </Btn>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
        <p role="alert" className={cx(field.error, !errors.payments && "sr-only")}>
          {errors.payments}
        </p>
      </section>

      {/* Totales */}
      <dl className="flex flex-col gap-1.5 rounded-xl border border-tinta/10 bg-hueso/40 p-4 text-sm">
        <TotalRow label="Servicios" value={fmt(subtotal)} />
        {discountTotal > 0n ? <TotalRow label="Descuentos" value={`− ${fmt(discountTotal)}`} /> : null}
        {tipsTotal > 0n ? <TotalRow label="Propinas" value={fmt(tipsTotal)} /> : null}
        <div className="mt-1 flex items-baseline justify-between border-t border-tinta/10 pt-2">
          <dt className="font-semibold">Total</dt>
          <dd className="monto text-xl font-semibold">{fmt(totalDue)}</dd>
        </div>
        {split && remaining !== 0n ? (
          <TotalRow label={remaining > 0n ? "Falta por cobrar" : "Sobra en los pagos"} value={fmt(remaining > 0n ? remaining : -remaining)} strong />
        ) : null}
        {change > 0n ? <TotalRow label="Cambio para el cliente" value={fmt(change)} strong /> : null}
      </dl>

      <div ref={summaryRef} tabIndex={-1} className="outline-none">
        <FormError message={errors.summary ?? null} />
      </div>

      <div className="sticky bottom-0 -mx-5 -mb-4 border-t border-tinta/10 bg-papel px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <Btn variant="success" size="xl" className="h-16 w-full text-xl" isPending={pending} isDisabled={blocked || totalDue <= 0n} onPress={submit}>
          <Banknote size={24} aria-hidden />
          {pending ? "Cobrando…" : <span className="monto">Cobrar {fmt(totalDue)}</span>}
        </Btn>
      </div>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cx(strong ? "font-semibold" : "text-tinta/70")}>{label}</dt>
      <dd className={cx("monto", strong && "text-base font-semibold")}>{value}</dd>
    </div>
  );
}

// ─── Líneas y descuentos ─────────────────────────────────────────────────────

function LineRow({
  line,
  net,
  cap,
  maxBps,
  canDiscount,
  discount,
  error,
  onDiscount,
  onRemove,
}: {
  line: UiLine;
  net: bigint;
  cap: bigint;
  maxBps: string;
  canDiscount: boolean;
  discount: Discount;
  error?: string;
  onDiscount: (d: Discount) => void;
  onRemove?: () => void;
}) {
  const discounted = net !== line.unit;
  const reasonError = error?.startsWith("Escribe") ? error : undefined;
  const amountError = error && !reasonError ? error : undefined;
  return (
    <li className="flex flex-col gap-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{line.name}</p>
          <p className="text-sm text-tinta/70">{line.staffName}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          {discounted ? (
            <>
              <span className="monto text-xs text-tinta/70 line-through">
                <span className="sr-only">Antes </span>
                {fmt(line.unit)}
              </span>
              <span className="monto font-semibold">{fmt(net)}</span>
            </>
          ) : (
            <span className="monto font-semibold">{fmt(line.unit)}</span>
          )}
        </div>
      </div>
      {canDiscount || onRemove ? (
        <div className="flex flex-wrap gap-2">
          {canDiscount ? (
            <Btn
              variant="ghost"
              size="sm"
              className="h-11"
              aria-expanded={discount.open}
              onPress={() => onDiscount(discount.open ? { open: false, digits: "", reason: "" } : { ...discount, open: true })}
            >
              <Percent size={16} aria-hidden />
              {discount.open ? "Quitar descuento" : "Descuento"}
              <span className="sr-only"> en {line.name}</span>
            </Btn>
          ) : null}
          {onRemove ? (
            <Btn variant="ghost" size="sm" className="h-11 text-alerta" onPress={onRemove}>
              <Trash2 size={16} aria-hidden /> Quitar<span className="sr-only"> {line.name}</span>
            </Btn>
          ) : null}
        </div>
      ) : null}
      {canDiscount && discount.open ? (
        <div className="grid grid-cols-1 gap-3 rounded-lg bg-hueso/50 p-3 min-[400px]:grid-cols-2">
          <MoneyField
            name={`discount-${line.uiKey}`}
            label="Descuento"
            value={discount.digits}
            onChange={(digits) => onDiscount({ ...discount, digits })}
            description={
              <>
                Máximo <span className="monto">{fmt(cap)}</span> ({bpsLabel(maxBps)})
              </>
            }
            error={amountError}
            autoFocus
          />
          <TextField
            name={`reason-${line.uiKey}`}
            value={discount.reason}
            onChange={(reason) => onDiscount({ ...discount, reason })}
            isRequired={unitsOf(discount.digits) > 0n}
            isInvalid={!!reasonError}
            maxLength={200}
            className={field.root}
          >
            <Label className={field.label}>Motivo</Label>
            <Input className={field.input} placeholder="Cliente frecuente" autoComplete="off" />
            <FieldMessage>{reasonError}</FieldMessage>
          </TextField>
        </div>
      ) : null}
    </li>
  );
}

function bpsLabel(bps: string): string {
  const v = big(bps);
  const frac = (v % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${v / 100n}${frac ? `,${frac}` : ""} %`;
}

function AddExtra({
  view,
  defaultStaff,
  initiallyOpen = false,
  onAdd,
}: {
  view: CheckoutView;
  defaultStaff: string;
  initiallyOpen?: boolean;
  onAdd: (x: { serviceId: string; staffId: string }) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState(defaultStaff);
  if (!open) {
    return (
      <Btn variant="secondary" onPress={() => setOpen(true)} className="self-start">
        <Plus size={16} aria-hidden /> Agregar servicio
      </Btn>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-tinta/20 p-3">
      <SelectField
        label="Servicio"
        options={view.extraServices.map((s) => ({ id: s.serviceId, label: s.name, description: s.unitPriceLabel }))}
        value={serviceId}
        onChange={setServiceId}
      />
      <SelectField label="Lo hizo" options={view.staff.map((s) => ({ id: s.id, label: s.name }))} value={staffId} onChange={setStaffId} />
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" onPress={() => setOpen(false)}>
          Cancelar
        </Btn>
        <Btn
          isDisabled={!serviceId || !staffId}
          onPress={() => {
            if (!serviceId || !staffId) return;
            onAdd({ serviceId, staffId });
            setServiceId(null);
            setOpen(false);
          }}
        >
          Agregar
        </Btn>
      </div>
    </div>
  );
}

// ─── Propinas ────────────────────────────────────────────────────────────────

function TipRow({
  staffId,
  name,
  tip,
  amount,
  error,
  onChange,
  onRemove,
}: {
  staffId: string;
  name: string;
  tip: Tip;
  amount: bigint;
  error?: string;
  onChange: (t: Tip) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-tinta/10 bg-papel p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold" id={`tip-label-${staffId}`}>
          Para {name}
        </p>
        <div className="flex items-center gap-1">
          <span className="monto text-sm font-semibold">{fmt(amount)}</span>
          {onRemove ? (
            <Btn variant="ghost" size="sm" className="h-11 w-11 px-0" aria-label={`Quitar la propina de ${name}`} onPress={onRemove}>
              <X size={16} aria-hidden />
            </Btn>
          ) : null}
        </div>
      </div>
      <ToggleButtonGroup
        aria-labelledby={`tip-label-${staffId}`}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[tip.mode]}
        onSelectionChange={(keys) => {
          const k = [...keys][0];
          if (k !== undefined) onChange({ mode: String(k) as TipMode, digits: String(k) === "otro" ? tip.digits : "" });
        }}
        className="grid grid-cols-4 gap-2"
      >
        {TIP_CHOICES.map((c) => (
          <ToggleButton
            key={c.id}
            id={c.id}
            className={({ isSelected, isFocusVisible }) =>
              cx(
                "monto inline-flex h-11 items-center justify-center rounded-lg border text-sm font-semibold transition-colors",
                isSelected ? "border-cuero bg-cuero text-hueso" : "border-tinta/15 bg-papel hover:border-tinta/40",
                isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
              )
            }
          >
            {c.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {tip.mode === "otro" ? (
        <MoneyField
          name={`tip-${staffId}`}
          label={`Propina para ${name}`}
          value={tip.digits}
          onChange={(digits) => onChange({ ...tip, digits })}
          error={error}
          autoFocus
        />
      ) : null}
    </div>
  );
}

function AddTipStaff({ options, onAdd }: { options: { id: string; name: string }[]; onAdd: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Btn variant="ghost" size="sm" className="h-11 self-start" onPress={() => setOpen(true)}>
        <Plus size={16} aria-hidden /> Propina para otra persona
      </Btn>
    );
  }
  return (
    <SelectField
      label="Propina para"
      options={options.map((s) => ({ id: s.id, label: s.name }))}
      value={null}
      onChange={(id) => {
        onAdd(id);
        setOpen(false);
      }}
    />
  );
}

// ─── Pagos ───────────────────────────────────────────────────────────────────

function methodText(m: Method): string {
  return m.label || KIND_LABEL[m.kind];
}

function SinglePayment({
  methods,
  usable,
  row,
  amount,
  change,
  tenderedError,
  onChange,
}: {
  methods: Method[];
  usable: (m: Method) => boolean;
  row: PayRow;
  amount: bigint;
  change: bigint;
  tenderedError?: string;
  onChange: (patch: Partial<PayRow>) => void;
}) {
  const method = methods.find((m) => m.id === row.methodId);
  const bills = [5_000_000n, 10_000_000n].filter((b) => b >= amount && amount > 0n);
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup
        aria-label="Medio de pago"
        value={row.methodId || null}
        onChange={(v) => onChange({ methodId: v, tendered: "" })}
        className="grid grid-cols-2 gap-2"
      >
        {methods.map((m) => (
          <Radio
            key={m.id}
            value={m.id}
            isDisabled={!usable(m)}
            className={({ isSelected, isFocusVisible, isDisabled }) =>
              cx(
                "flex min-h-12 cursor-pointer flex-col justify-center rounded-lg border px-3 py-2 text-sm font-semibold transition-colors",
                isSelected ? "border-cuero bg-cuero/8 ring-1 ring-cuero" : "border-tinta/15 bg-papel",
                isDisabled && "cursor-default opacity-60",
                isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
              )
            }
          >
            {({ isSelected, isDisabled }) => (
              <>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cx("h-4 w-4 shrink-0 rounded-full border-2", isSelected ? "border-[5px] border-cuero" : "border-tinta/50")}
                  />
                  {methodText(m)}
                </span>
                {isDisabled ? <span className="pl-6 text-xs font-normal text-tinta/70">Caja cerrada</span> : null}
              </>
            )}
          </Radio>
        ))}
      </RadioGroup>

      {method?.kind === "cash" ? (
        <div className="flex flex-col gap-3 rounded-xl border border-tinta/10 bg-hueso/40 p-3">
          <MoneyField
            name={`tendered-${row.uid}`}
            label="El cliente entrega"
            value={row.tendered}
            onChange={(tendered) => onChange({ tendered })}
            description="Vacío si paga exacto."
            error={tenderedError}
            size="lg"
          />
          <div className="flex flex-wrap gap-2" role="group" aria-label="Billetes rápidos">
            <QuickBill label="Exacto" pressed={!row.tendered} onPress={() => onChange({ tendered: "" })} />
            {bills.map((b) => (
              <QuickBill key={b.toString()} label={fmt(b)} pressed={row.tendered === (b / PESO).toString()} onPress={() => onChange({ tendered: (b / PESO).toString() })} />
            ))}
          </div>
          <ChangeLine change={change} />
        </div>
      ) : null}
    </div>
  );
}

function QuickBill({ label, pressed, onPress }: { label: string; pressed: boolean; onPress: () => void }) {
  return (
    <Btn variant={pressed ? "primary" : "secondary"} aria-pressed={pressed} onPress={onPress} className="monto min-w-24">
      {label}
    </Btn>
  );
}

function ChangeLine({ change }: { change: bigint }) {
  return (
    <p className="flex items-baseline justify-between rounded-lg bg-papel px-3 py-2" aria-live="polite">
      <span className="text-sm font-semibold">Cambio</span>
      <span className="monto text-2xl font-semibold">{fmt(change)}</span>
    </p>
  );
}

function SplitRow({
  row,
  method,
  amount,
  change,
  tenderedError,
  onChange,
  onRemove,
}: {
  row: PayRow;
  method: Method | undefined;
  amount: bigint;
  change: bigint;
  tenderedError?: string;
  onChange: (patch: Partial<PayRow>) => void;
  onRemove?: () => void;
}) {
  const label = method ? methodText(method) : "Medio";
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-tinta/10 bg-papel p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold">{label}</p>
        {onRemove ? (
          <Btn variant="ghost" size="sm" className="h-11 w-11 px-0" aria-label={`Quitar el pago con ${label}`} onPress={onRemove}>
            <Trash2 size={16} aria-hidden />
          </Btn>
        ) : null}
      </div>
      <MoneyField name={`amount-${row.uid}`} label={`Monto con ${label}`} value={row.digits} onChange={(digits) => onChange({ digits })} />
      {method?.kind === "cash" ? (
        <>
          <MoneyField
            name={`tendered-${row.uid}`}
            label="El cliente entrega"
            value={row.tendered}
            onChange={(tendered) => onChange({ tendered })}
            description={amount > 0n ? <>Vacío si entrega exacto ({fmt(amount)}).</> : "Vacío si entrega exacto."}
            error={tenderedError}
          />
          <ChangeLine change={change} />
        </>
      ) : null}
    </div>
  );
}

// ─── Recibo ──────────────────────────────────────────────────────────────────

function ReceiptView({ receipt, onDone }: { receipt: Receipt; onDone: () => void }) {
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const text = [
    "Villa · Recibo",
    longDate(receipt.businessDate),
    "",
    ...receipt.lines.map((l) => `${l.description}: ${l.netLabel}`),
    ...receipt.tips.map((t) => `Propina ${t.staffName}: ${t.amountLabel}`),
    "",
    `Total: ${receipt.totalLabel}`,
    ...receipt.payments.map((p) => `${p.label}: ${p.amountLabel}`),
    ...(receipt.changeLabel ? [`Cambio: ${receipt.changeLabel}`] : []),
  ].join("\n");

  async function share() {
    try {
      if (typeof navigator !== "undefined" && "share" in navigator) {
        await navigator.share({ title: "Recibo de Villa", text });
        return;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("Recibo copiado: pégalo en WhatsApp o donde quieras");
    } catch {
      toast("No se pudo compartir ni copiar el recibo", "error");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center" role="status">
        <CheckCircle2 size={40} className="text-botella" aria-hidden />
        <h3 ref={headingRef} tabIndex={-1} className="font-display text-2xl outline-none">
          Cobro registrado
        </h3>
        <p className="text-sm text-tinta/70">{longDate(receipt.businessDate)}</p>
      </div>

      {receipt.changeLabel ? (
        <div className="flex items-baseline justify-between rounded-xl bg-botella px-4 py-3 text-hueso">
          <span className="font-semibold">Cambio para el cliente</span>
          <span className="monto text-3xl font-semibold">{receipt.changeLabel}</span>
        </div>
      ) : null}

      {/* Tiquete con borde perforado (docs/00-descubrimiento.md §10). */}
      <div className="relative rounded-xl border border-tinta/10 bg-hueso/50 p-4">
        <span className="absolute -left-3 top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-papel" aria-hidden />
        <span className="absolute -right-3 top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-papel" aria-hidden />
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
          <ReceiptIcon size={14} aria-hidden /> Recibo
        </p>
        <dl className="flex flex-col gap-1.5 text-sm">
          {receipt.lines.map((l, i) => (
            <TotalRow key={`l${i}`} label={l.description} value={l.netLabel} />
          ))}
          {receipt.tips.map((t, i) => (
            <TotalRow key={`t${i}`} label={`Propina · ${t.staffName}`} value={t.amountLabel} />
          ))}
          <div className="my-1 border-t border-dashed border-tinta/25" />
          <div className="flex items-baseline justify-between">
            <dt className="font-semibold">Total</dt>
            <dd className="monto text-xl font-semibold">{receipt.totalLabel}</dd>
          </div>
          {receipt.payments.map((p, i) => (
            <TotalRow key={`p${i}`} label={p.label} value={p.amountLabel} />
          ))}
        </dl>
      </div>

      <div className="flex flex-col gap-2 min-[400px]:flex-row">
        <Btn variant="secondary" size="lg" className="flex-1" onPress={share}>
          <Share2 size={18} aria-hidden /> Compartir recibo
        </Btn>
        <Btn size="lg" className="flex-1" onPress={onDone}>
          Listo
        </Btn>
      </div>
    </div>
  );
}

