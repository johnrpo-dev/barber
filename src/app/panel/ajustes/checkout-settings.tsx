"use client";

import { Banknote, CreditCard, Landmark, Pencil, Plus, Smartphone, Tag } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import { Form, Input, Label, Radio, RadioGroup, Text, TextField } from "react-aria-components";
import { bpsToPercentText, MoneyField, percentTextToBps } from "../_components/money-field";
import { useReauth } from "../_components/reauth";
import { SelectField } from "../_components/select-field";
import { Btn, cx, field, Sheet, useToast } from "../_components/ui";
import { card, Chip, FieldMessage, FormError, RadioDot, radioCard, Toggle, useFieldErrors } from "../_manage/controls";
import { saveExpenseCategoryAction, savePaymentMethodAction, updateCheckoutRulesAction } from "./actions";

// Ajustes del cobro (docs/sprint-4-cobro-caja.md §1 y §9): medios de pago con su costo de
// datáfono, categorías de gasto y reglas de cobro. Los porcentajes viajan en puntos básicos
// como texto ("299" = 2,99 %), convertidos con manejo de texto, nunca con floats.

export type PaymentKind = "cash" | "card" | "transfer" | "wallet";

export interface MethodRow {
  id: string;
  kind: PaymentKind;
  label: string;
  feeBps: string;
  active: boolean;
}

export interface CategoryRow {
  id: string;
  name: string;
  accountCode: string;
  active: boolean;
}

export interface CheckoutRulesView {
  commissionBase: "net" | "gross";
  maxDiscountBps: string;
  receptionCanDiscount: boolean;
  tipsBearCardFees: boolean;
  cashReviewThresholdUnits: string;
}

export interface AccountOption {
  code: string;
  name: string;
}

const KIND_LABEL: Record<PaymentKind, string> = { cash: "Efectivo", card: "Tarjeta (datáfono)", transfer: "Transferencia", wallet: "Billetera (Nequi, Daviplata)" };
const KIND_ICON = { cash: Banknote, card: CreditCard, transfer: Landmark, wallet: Smartphone } as const;

function SectionTitle({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 id={id} className="font-display text-2xl leading-tight">
        {title}
      </h2>
      {children ? <p className="max-w-prose text-sm text-tinta/70">{children}</p> : null}
    </div>
  );
}

export function CheckoutSettings({
  methods,
  categories,
  rules,
  accounts,
}: {
  methods: MethodRow[];
  categories: CategoryRow[];
  rules: CheckoutRulesView;
  accounts: AccountOption[];
}) {
  return (
    <>
      <RulesSection rules={rules} />
      <MethodsSection methods={methods} />
      <CategoriesSection categories={categories} accounts={accounts} />
    </>
  );
}

// ─── Reglas de cobro ─────────────────────────────────────────────────────────

function RulesSection({ rules }: { rules: CheckoutRulesView }) {
  const reauth = useReauth({ description: "Las reglas de cobro cambian comisiones, descuentos y propinas." });
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const invalid = useFieldErrors<"maxDiscount" | "reviewThreshold">();
  const [commissionBase, setCommissionBase] = useState(rules.commissionBase);
  const [maxDiscount, setMaxDiscount] = useState(bpsToPercentText(rules.maxDiscountBps));
  const [receptionCanDiscount, setReceptionCanDiscount] = useState(rules.receptionCanDiscount);
  const [tipsBearCardFees, setTipsBearCardFees] = useState(rules.tipsBearCardFees);
  const [reviewThreshold, setReviewThreshold] = useState(rules.cashReviewThresholdUnits);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const bps = percentTextToBps(maxDiscount);
    if (
      !invalid.check(e.currentTarget, {
        ...(bps === null || bps > 10_000n ? { maxDiscount: "Debe ser un porcentaje entre 0 y 100, por ejemplo 30 o 12,5." } : {}),
        ...(reviewThreshold === "" ? { reviewThreshold: "Escribe el límite en pesos (0 para revisar cualquier diferencia)." } : {}),
      })
    )
      return;
    startTransition(async () => {
      const r = await reauth.run(() =>
        updateCheckoutRulesAction({
          commissionBase,
          maxDiscountBps: bps!.toString(),
          receptionCanDiscount,
          tipsBearCardFees,
          cashReviewThresholdUnits: reviewThreshold,
        }),
      );
      if (!r.ok) return setError(r.error);
      toast("Reglas de cobro guardadas");
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="reglas-cobro" className={cx(card, "flex flex-col gap-5 p-5")}>
      <SectionTitle id="reglas-cobro" title="Reglas de cobro">
        Aplican a los cobros nuevos. Lo ya cobrado queda congelado como se cobró.
      </SectionTitle>
      <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-5">
        <RadioGroup value={commissionBase} onChange={(v) => setCommissionBase(v as "net" | "gross")} className={field.root}>
          <Label className={field.label}>La comisión del barbero se calcula sobre</Label>
          <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
            <Radio value="net" className={cx(radioCard, "group")}>
              <RadioDot />
              <span className="flex flex-col">
                Precio neto
                <span className="text-xs font-normal text-tinta/70">Después del descuento</span>
              </span>
            </Radio>
            <Radio value="gross" className={cx(radioCard, "group")}>
              <RadioDot />
              <span className="flex flex-col">
                Precio bruto
                <span className="text-xs font-normal text-tinta/70">Antes del descuento</span>
              </span>
            </Radio>
          </div>
        </RadioGroup>

        <TextField
          name="maxDiscount"
          value={maxDiscount}
          onChange={(v) => (setMaxDiscount(v), invalid.clear("maxDiscount"))}
          isInvalid={!!invalid.errors.maxDiscount}
          inputMode="decimal"
          className={field.root}
        >
          <Label className={field.label}>Descuento máximo por servicio</Label>
          <div className="relative max-w-40">
            <Input className={cx(field.input, "monto pr-9")} autoComplete="off" />
            <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-base text-tinta/70">
              %
            </span>
          </div>
          <Text slot="description" className={field.description}>
            Sobre el precio de la línea. Todo descuento pide motivo.
          </Text>
          <FieldMessage>{invalid.errors.maxDiscount}</FieldMessage>
        </TextField>

        <Toggle isSelected={receptionCanDiscount} onChange={setReceptionCanDiscount}>
          <span className="flex flex-col">
            Recepción puede dar descuentos
            <span className="text-xs font-normal text-tinta/70">{receptionCanDiscount ? "Sí, hasta el máximo" : "No: solo el dueño"}</span>
          </span>
        </Toggle>
        <Toggle isSelected={tipsBearCardFees} onChange={setTipsBearCardFees}>
          <span className="flex flex-col">
            La propina con tarjeta asume su parte del datáfono
            <span className="text-xs font-normal text-tinta/70">
              {tipsBearCardFees ? "Sí: se reparte el costo entre venta y propinas" : "No: el negocio asume todo el costo"}
            </span>
          </span>
        </Toggle>

        <MoneyField
          name="reviewThreshold"
          label="Revisar cierres de caja con diferencia mayor a"
          value={reviewThreshold}
          onChange={(v) => (setReviewThreshold(v), invalid.clear("reviewThreshold"))}
          error={invalid.errors.reviewThreshold}
          isRequired
          className="max-w-60"
          description="Faltante o sobrante. Esos cierres te aparecen en Caja para revisarlos. Recepción cuenta sin ver el esperado."
        />

        <FormError message={error} />
        <div className="flex justify-end">
          <Btn type="submit" isPending={pending} className="w-full min-[400px]:w-auto">
            {pending ? "Guardando…" : "Guardar reglas"}
          </Btn>
        </div>
        {reauth.dialog}
      </Form>
    </section>
  );
}

// ─── Medios de pago ──────────────────────────────────────────────────────────

function MethodsSection({ methods }: { methods: MethodRow[] }) {
  const [editing, setEditing] = useState<MethodRow | "new" | null>(null);
  return (
    <section aria-labelledby="medios-pago" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle id="medios-pago" title="Medios de pago">
          El costo del datáfono o la pasarela lo asume el negocio; no reduce la comisión del barbero.
        </SectionTitle>
        <Btn variant="secondary" onPress={() => setEditing("new")}>
          <Plus size={18} aria-hidden /> Agregar
        </Btn>
      </div>
      <ul className={cx(card, "divide-y divide-tinta/10")}>
        {methods.map((m) => {
          const Icon = KIND_ICON[m.kind];
          return (
            <li key={m.id} className="flex items-center gap-3 px-4 py-3">
              <Icon size={20} className="shrink-0 text-tinta/70" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{m.label}</p>
                <p className="text-xs text-tinta/70">
                  {KIND_LABEL[m.kind]} · Costo <span className="monto">{bpsToPercentText(m.feeBps)} %</span>
                </p>
              </div>
              <Chip tone={m.active ? "success" : "muted"}>{m.active ? "Activo" : "Inactivo"}</Chip>
              <Btn variant="ghost" size="sm" className="h-11 w-11 px-0" aria-label={`Editar ${m.label}`} onPress={() => setEditing(m)}>
                <Pencil size={16} aria-hidden />
              </Btn>
            </li>
          );
        })}
      </ul>
      <Sheet
        isOpen={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === "new" ? "Nuevo medio de pago" : "Editar medio de pago"}
      >
        {editing ? <MethodForm key={editing === "new" ? "new" : editing.id} method={editing === "new" ? null : editing} onDone={() => setEditing(null)} /> : null}
      </Sheet>
    </section>
  );
}

function MethodForm({ method, onDone }: { method: MethodRow | null; onDone: () => void }) {
  const reauth = useReauth({ description: "El costo de un medio de pago se descuenta de cada cobro." });
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const invalid = useFieldErrors<"label" | "fee">();
  const isCash = method?.kind === "cash";
  const [label, setLabel] = useState(method?.label ?? "");
  const [kind, setKind] = useState<PaymentKind>(method?.kind ?? "card");
  const [fee, setFee] = useState(method ? bpsToPercentText(method.feeBps) : "0");
  const [active, setActive] = useState(method?.active ?? true);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const bps = isCash ? 0n : percentTextToBps(fee);
    if (
      !invalid.check(e.currentTarget, {
        ...(label.trim().length < 2 ? { label: "Escribe un nombre de al menos 2 letras." } : {}),
        ...(bps === null || bps > 9_999n ? { fee: "Debe estar entre 0 y 99,99 %, por ejemplo 2,99." } : {}),
      })
    )
      return;
    startTransition(async () => {
      const r = await reauth.run(() =>
        savePaymentMethodAction({
          ...(method ? { id: method.id } : {}),
          kind,
          label: label.trim(),
          feeBps: bps!.toString(),
          active: isCash ? true : active,
        }),
      );
      if (!r.ok) return setError(r.error);
      toast(method ? "Medio de pago actualizado" : "Medio de pago agregado");
      router.refresh();
      onDone();
    });
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-5">
      <TextField
        name="label"
        value={label}
        onChange={(v) => (setLabel(v), invalid.clear("label"))}
        isRequired
        isInvalid={!!invalid.errors.label}
        maxLength={40}
        autoFocus
        className={field.root}
      >
        <Label className={field.label}>Nombre</Label>
        <Input className={field.input} placeholder="Datáfono Bold" autoComplete="off" />
        <FieldMessage>{invalid.errors.label}</FieldMessage>
      </TextField>

      {isCash ? (
        <p className="rounded-lg bg-hueso/60 p-3 text-sm text-tinta/80">El efectivo siempre está activo y no tiene costo.</p>
      ) : (
        <>
          <RadioGroup value={kind} onChange={(v) => setKind(v as PaymentKind)} className={field.root}>
            <Label className={field.label}>Tipo</Label>
            <div className="grid grid-cols-1 gap-2">
              {(["card", "transfer", "wallet"] as const).map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <Radio key={k} value={k} className={cx(radioCard, "group")}>
                    <RadioDot />
                    <Icon size={16} aria-hidden /> {KIND_LABEL[k]}
                  </Radio>
                );
              })}
            </div>
          </RadioGroup>
          <TextField name="fee" value={fee} onChange={(v) => (setFee(v), invalid.clear("fee"))} isInvalid={!!invalid.errors.fee} inputMode="decimal" className={field.root}>
            <Label className={field.label}>Costo por pago</Label>
            <div className="relative max-w-40">
              <Input className={cx(field.input, "monto pr-9")} autoComplete="off" />
              <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-base text-tinta/70">
                %
              </span>
            </div>
            <Text slot="description" className={field.description}>
              Lo que cobra el datáfono o la pasarela, con hasta 2 decimales (2,99).
            </Text>
            <FieldMessage>{invalid.errors.fee}</FieldMessage>
          </TextField>
          <Toggle isSelected={active} onChange={setActive}>
            {active ? "Activo: aparece al cobrar" : "Inactivo: no aparece al cobrar"}
          </Toggle>
        </>
      )}

      <FormError message={error} />
      <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onDone} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" isPending={pending}>
          {pending ? "Guardando…" : "Guardar"}
        </Btn>
      </div>
      {reauth.dialog}
    </Form>
  );
}

// ─── Categorías de gasto ─────────────────────────────────────────────────────

function CategoriesSection({ categories, accounts }: { categories: CategoryRow[]; accounts: AccountOption[] }) {
  const [editing, setEditing] = useState<CategoryRow | "new" | null>(null);
  const accountName = (code: string) => accounts.find((a) => a.code === code)?.name ?? code;
  return (
    <section aria-labelledby="categorias-gasto" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle id="categorias-gasto" title="Categorías de gasto">
          Cada categoría va a una cuenta de gasto. El contador puede ajustar el mapeo.
        </SectionTitle>
        <Btn variant="secondary" onPress={() => setEditing("new")}>
          <Plus size={18} aria-hidden /> Agregar
        </Btn>
      </div>
      {categories.length === 0 ? (
        <p className="text-sm text-tinta/70">Todavía no hay categorías.</p>
      ) : (
        <ul className={cx(card, "divide-y divide-tinta/10")}>
          {categories.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3">
              <Tag size={18} className="shrink-0 text-tinta/70" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{c.name}</p>
                <p className="truncate text-xs text-tinta/70">
                  <span className="monto">{c.accountCode}</span> · {accountName(c.accountCode)}
                </p>
              </div>
              <Chip tone={c.active ? "success" : "muted"}>{c.active ? "Activa" : "Inactiva"}</Chip>
              <Btn variant="ghost" size="sm" className="h-11 w-11 px-0" aria-label={`Editar ${c.name}`} onPress={() => setEditing(c)}>
                <Pencil size={16} aria-hidden />
              </Btn>
            </li>
          ))}
        </ul>
      )}
      <Sheet isOpen={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === "new" ? "Nueva categoría" : "Editar categoría"}>
        {editing ? (
          <CategoryForm key={editing === "new" ? "new" : editing.id} category={editing === "new" ? null : editing} accounts={accounts} onDone={() => setEditing(null)} />
        ) : null}
      </Sheet>
    </section>
  );
}

function CategoryForm({ category, accounts, onDone }: { category: CategoryRow | null; accounts: AccountOption[]; onDone: () => void }) {
  const reauth = useReauth({ description: "La categoría decide a qué cuenta del libro van los gastos." });
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const invalid = useFieldErrors<"name" | "account">();
  const [name, setName] = useState(category?.name ?? "");
  const [accountCode, setAccountCode] = useState<string | null>(category?.accountCode ?? accounts[0]?.code ?? null);
  const [active, setActive] = useState(category?.active ?? true);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (
      !invalid.check(e.currentTarget, {
        ...(name.trim().length < 2 ? { name: "Escribe un nombre de al menos 2 letras." } : {}),
        ...(!accountCode ? { account: "Elige la cuenta." } : {}),
      })
    )
      return;
    startTransition(async () => {
      const r = await reauth.run(() =>
        saveExpenseCategoryAction({ ...(category ? { id: category.id } : {}), name: name.trim(), accountCode: accountCode!, active }),
      );
      if (!r.ok) return setError(r.error);
      toast(category ? "Categoría actualizada" : "Categoría agregada");
      router.refresh();
      onDone();
    });
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-5">
      <TextField
        name="name"
        value={name}
        onChange={(v) => (setName(v), invalid.clear("name"))}
        isRequired
        isInvalid={!!invalid.errors.name}
        maxLength={60}
        autoFocus
        className={field.root}
      >
        <Label className={field.label}>Nombre</Label>
        <Input className={field.input} placeholder="Insumos" autoComplete="off" />
        <FieldMessage>{invalid.errors.name}</FieldMessage>
      </TextField>
      <SelectField
        name="account"
        label="Cuenta contable"
        options={accounts.map((a) => ({ id: a.code, label: `${a.code} · ${a.name}` }))}
        value={accountCode}
        onChange={(v) => (setAccountCode(v), invalid.clear("account"))}
        error={invalid.errors.account}
        description="Solo cuentas de gasto sin flujo propio (no comisiones, datáfono ni diferencias de caja)."
        isRequired
      />
      <Toggle isSelected={active} onChange={setActive}>
        {active ? "Activa: aparece al registrar gastos" : "Inactiva: no aparece"}
      </Toggle>
      <FormError message={error} />
      <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onDone} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" isPending={pending}>
          {pending ? "Guardando…" : "Guardar"}
        </Btn>
      </div>
      {reauth.dialog}
    </Form>
  );
}
