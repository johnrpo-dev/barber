"use client";

import { Package, PackagePlus, Pencil, Plus } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import { Form, Input, Label, Text, TextField } from "react-aria-components";
import { PESO } from "@/domain/money";
import { bpsToPercentText, MoneyField, percentTextToBps, unitsOf } from "../_components/money-field";
import { useReauth } from "../_components/reauth";
import { Btn, cx, field, PageHeader, Sheet, SheetFooter, useToast } from "../_components/ui";
import { card, FieldMessage, FormError, Toggle, useFieldErrors } from "../_manage/controls";
import { createProductAction, recordPurchaseAction, setProductActiveAction, updateProductAction } from "./actions";
import { PurchaseForm } from "./purchase-form";

// Productos (sprint 6, docs/sprint-6-productos-inventario.md): catálogo del dueño y compras del banco
// o carga inicial. La compra pagada de la caja se registra desde Caja (también recepción).

export interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  /** Centavos como texto (bigint no viaja en JSON). */
  priceMinor: string;
  priceLabel: string;
  commissionBps: number;
  active: boolean;
  /** Costo unitario de la última compra, o null si nunca se ha comprado. */
  unitCostLabel: string | null;
}

type Editing = { mode: "create" } | { mode: "edit"; product: ProductRow } | { mode: "purchase" } | null;

export function ProductsManager({ products, inventoryLabel }: { products: ProductRow[]; inventoryLabel: string }) {
  const toast = useToast();
  const [editing, setEditing] = useState<Editing>(null);
  const active = products.filter((p) => p.active);

  return (
    <>
      <PageHeader
        eyebrow="Inventario"
        title="Productos"
        actions={
          <div className="flex flex-wrap gap-2">
            <Btn variant="secondary" onPress={() => setEditing({ mode: "purchase" })} isDisabled={active.length === 0}>
              <PackagePlus size={18} aria-hidden />
              Registrar compra
            </Btn>
            <Btn onPress={() => setEditing({ mode: "create" })}>
              <Plus size={18} aria-hidden />
              Nuevo producto
            </Btn>
          </div>
        }
      />

      <div className={cx(card, "flex flex-col gap-1 p-4")}>
        <p className="text-sm text-tinta/70">Inventario según el libro</p>
        <p className="monto text-2xl font-semibold">{inventoryLabel}</p>
        <p className="text-xs text-tinta/70">
          Sube con cada compra. El conteo del último día del mes lo deja en lo que de verdad hay; la diferencia es el costo de lo vendido.
        </p>
      </div>

      {products.length === 0 ? (
        <div className={cx(card, "flex flex-col items-center gap-3 px-6 py-12 text-center")}>
          <span aria-hidden className="grid h-12 w-12 place-items-center rounded-full bg-botella/10 text-botella">
            <Package size={22} strokeWidth={1.75} />
          </span>
          <p className="font-display text-xl">Aún no hay productos</p>
          <p className="max-w-sm text-sm text-tinta/70">Cera, aceite para barba, shampoo… Crea los que vendes para registrar sus compras.</p>
          <Btn variant="secondary" onPress={() => setEditing({ mode: "create" })}>
            <Plus size={18} aria-hidden />
            Crear producto
          </Btn>
        </div>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Productos">
          {products.map((p) => (
            <li key={p.id} className={cx(card, "flex flex-col gap-3 p-4", !p.active && "bg-papel/60")}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className={cx("text-base font-semibold", !p.active && "text-tinta/70")}>{p.name}</p>
                  {p.sku ? <p className="text-xs text-tinta/70">Ref. {p.sku}</p> : null}
                  <p className="text-sm text-tinta/70">
                    {p.unitCostLabel ? (
                      <>
                        Última compra: <span className="monto font-semibold text-tinta">{p.unitCostLabel}</span> c/u
                      </>
                    ) : (
                      "Sin compras todavía"
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end">
                  <span className="text-xs text-tinta/70">Precio de venta</span>
                  <span className="monto text-lg font-semibold">{p.priceLabel}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-tinta/10 pt-3">
                <ActiveToggle product={p} onError={(m) => toast(m, "error")} />
                <Btn variant="ghost" onPress={() => setEditing({ mode: "edit", product: p })} aria-label={`Editar ${p.name}`}>
                  <Pencil size={16} aria-hidden />
                  Editar
                </Btn>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Sheet
        isOpen={editing?.mode === "create" || editing?.mode === "edit"}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.mode === "edit" ? "Editar producto" : "Nuevo producto"}
        description={editing?.mode === "edit" ? editing.product.name : "Nombre, referencia y precio de venta."}
      >
        {editing?.mode === "create" || editing?.mode === "edit" ? (
          <ProductForm
            key={editing.mode === "edit" ? editing.product.id : "new"}
            product={editing.mode === "edit" ? editing.product : null}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Sheet>

      <Sheet
        isOpen={editing?.mode === "purchase"}
        onOpenChange={(open) => !open && setEditing(null)}
        title="Registrar compra"
        description="Pagada del banco o carga inicial. La compra en efectivo se registra en Caja."
      >
        {editing?.mode === "purchase" ? (
          <PurchaseForm
            products={active.map((p) => ({ id: p.id, name: p.name, priceMinor: p.priceMinor }))}
            paidFromOptions={["bank", "owner"]}
            submit={({ paidFrom, lines, note, idempotencyKey }) =>
              recordPurchaseAction({ paidFrom: paidFrom === "cash" ? "bank" : paidFrom, lines, note, idempotencyKey })
            }
            onDone={(m) => {
              setEditing(null);
              toast(m);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function ActiveToggle({ product, onError }: { product: ProductRow; onError: (m: string) => void }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const isSelected = optimistic ?? product.active;

  function onChange(active: boolean) {
    setOptimistic(active);
    startTransition(async () => {
      const res = await setProductActiveAction({ productId: product.id, active });
      if (res.ok) toast(active ? `${product.name} vuelve a estar disponible` : `${product.name} quedó retirado`);
      else onError(res.error);
      setOptimistic(null);
    });
  }

  return (
    <Toggle isSelected={isSelected} onChange={onChange} isDisabled={pending}>
      <span className={cx("w-16", isSelected ? "text-botella" : "text-tinta/70")}>
        <span className="sr-only">{product.name}: </span>
        {isSelected ? "Activo" : "Retirado"}
      </span>
    </Toggle>
  );
}

function ProductForm({ product, onDone }: { product: ProductRow | null; onDone: () => void }) {
  // Crear un producto o cambiar su precio o su comisión pide confirmar identidad (lo decide el servidor).
  const reauth = useReauth({ description: "El precio y la comisión de un producto deciden cuánto se cobra y cuánto se le paga a quien lo vende." });
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const invalid = useFieldErrors<"name" | "price" | "commission">();

  const [name, setName] = useState(product?.name ?? "");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [priceDigits, setPriceDigits] = useState(product ? (BigInt(product.priceMinor) / PESO).toString() : "");
  const [commission, setCommission] = useState(product ? bpsToPercentText(BigInt(product.commissionBps)) : "0");
  const [active, setActive] = useState(product?.active ?? true);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const bps = percentTextToBps(commission);
    const ok = invalid.check(e.currentTarget, {
      ...(name.trim().length < 2 ? { name: "Escribe un nombre de al menos 2 caracteres." } : {}),
      ...(priceDigits === "" ? { price: "Escribe el precio de venta." } : {}),
      ...(bps === null || bps > 10_000n ? { commission: "Debe ser un porcentaje entre 0 y 100, por ejemplo 10 o 7,5." } : {}),
    });
    if (!ok) return;
    const payload = { name, sku: sku.trim() || undefined, priceUnits: unitsOf(priceDigits).toString(), commission, active };
    startTransition(async () => {
      const res = await reauth.run(() => (product ? updateProductAction({ ...payload, productId: product.id }) : createProductAction(payload)));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast(product ? "Producto actualizado" : "Producto creado");
      onDone();
    });
  }

  return (
    <Form onSubmit={onSubmit} className="flex flex-col gap-5" validationBehavior="aria">
      <TextField
        name="name"
        value={name}
        onChange={(v) => (setName(v), invalid.clear("name"))}
        isRequired
        isInvalid={!!invalid.errors.name}
        maxLength={80}
        autoFocus
        className={field.root}
      >
        <Label className={field.label}>Nombre</Label>
        <Input className={field.input} placeholder="Cera mate" />
        <FieldMessage>{invalid.errors.name}</FieldMessage>
      </TextField>

      <TextField name="sku" value={sku} onChange={setSku} maxLength={40} className={field.root}>
        <Label className={field.label}>Referencia (opcional)</Label>
        <Input className={field.input} placeholder="Código del proveedor" autoComplete="off" />
      </TextField>

      <MoneyField
        name="price"
        label="Precio de venta"
        value={priceDigits}
        onChange={(v) => (setPriceDigits(v), invalid.clear("price"))}
        error={invalid.errors.price}
        description="En pesos, sin centavos. Cambiarlo no toca nada ya registrado."
        isRequired
      />

      <TextField
        name="commission"
        value={commission}
        onChange={(v) => (setCommission(v), invalid.clear("commission"))}
        isRequired
        isInvalid={!!invalid.errors.commission}
        inputMode="decimal"
        className={field.root}
      >
        <Label className={field.label}>Comisión de quien lo vende</Label>
        <div className="relative">
          <Input className={cx(field.input, "monto pr-9")} placeholder="0" autoComplete="off" />
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-base text-tinta/70">
            %
          </span>
        </div>
        <Text slot="description" className={field.description}>
          Porcentaje; acepta decimales con coma. Se aplicará cuando se vendan productos en el cobro.
        </Text>
        <FieldMessage>{invalid.errors.commission}</FieldMessage>
      </TextField>

      <Toggle isSelected={active} onChange={setActive}>
        <span className="flex flex-col">
          <span>Activo</span>
          <span className="text-xs font-normal text-tinta/70">{active ? "Se puede comprar y contar." : "Retirado; el historial se conserva."}</span>
        </span>
      </Toggle>

      <FormError message={error} />

      <SheetFooter className="flex-col-reverse min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onDone} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" isPending={pending}>
          {pending ? "Guardando…" : product ? "Guardar cambios" : "Crear producto"}
        </Btn>
      </SheetFooter>
      {reauth.dialog}
    </Form>
  );
}
