"use client";

import { Clock, Pencil, Plus, Scissors } from "lucide-react";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import { Form, Input, Label, Text, TextField } from "react-aria-components";
import { percentToBps } from "@/domain/catalog/service";
import { format, fromUnits, PESO, percentOf } from "@/domain/money";
import { useReauth } from "../_components/reauth";
import { Btn, cx, field, PageHeader, Sheet, useToast } from "../_components/ui";
import { card, Chip, FieldMessage, FormError, MinutesField, Toggle, useFieldErrors } from "../_manage/controls";
import { createServiceAction, setServiceActiveAction, updateServiceAction } from "./actions";

export interface ServiceRow {
  id: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  /** Centavos como texto (bigint no viaja en JSON). */
  priceMinor: string;
  /** Formateado en el servidor con format(). */
  priceLabel: string;
  commissionBps: number;
  active: boolean;
}

// ─── Formato de entrada ──────────────────────────────────────────────────────

/** Solo dígitos, sin ceros a la izquierda: "035.000" → "35000". */
function onlyDigits(value: string): string {
  return value.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 10);
}

/** "35000" → "35.000". Es manejo de texto: el monto nunca pasa por number. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** 3750 → "37,5"; 4000 → "40". Los puntos básicos son enteros, no dinero. */
function bpsToPercentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole},${fraction}` : String(whole);
}

function durationLabel(durationMin: number, bufferMin: number): string {
  return bufferMin > 0 ? `${durationMin} min (+${bufferMin} limpieza)` : `${durationMin} min`;
}

// ─── Pantalla ────────────────────────────────────────────────────────────────

type Editing = { mode: "create" } | { mode: "edit"; service: ServiceRow } | null;

export function ServicesManager({ services }: { services: ServiceRow[] }) {
  const [editing, setEditing] = useState<Editing>(null);
  const activeCount = services.filter((s) => s.active).length;

  return (
    <>
      <PageHeader
        eyebrow="Catálogo"
        title="Servicios"
        actions={
          <Btn onPress={() => setEditing({ mode: "create" })}>
            <Plus size={18} aria-hidden />
            Nuevo servicio
          </Btn>
        }
      />

      <p className="-mt-2 max-w-prose text-sm text-tinta/70">
        {services.length === 0
          ? "Aún no hay servicios. Crea el primero para poder agendar citas."
          : `${activeCount} de ${services.length} servicios están activos y se pueden agendar.`}
      </p>

      {services.length === 0 ? (
        <div className={cx(card, "flex flex-col items-center gap-3 px-6 py-12 text-center")}>
          <span aria-hidden className="grid h-12 w-12 place-items-center rounded-full bg-botella/10 text-botella">
            <Scissors size={22} strokeWidth={1.75} />
          </span>
          <p className="font-display text-xl">Tu catálogo está vacío</p>
          <p className="max-w-sm text-sm text-tinta/70">Corte, barba, combo… cada servicio define su precio, su duración y la comisión del barbero.</p>
          <Btn variant="secondary" onPress={() => setEditing({ mode: "create" })}>
            <Plus size={18} aria-hidden />
            Crear servicio
          </Btn>
        </div>
      ) : (
        <>
          {/* Celular: tarjetas */}
          <ul className="flex flex-col gap-3 md:hidden" aria-label="Servicios">
            {services.map((s) => (
              <li key={s.id} className={cx(card, "flex flex-col gap-3 p-4", !s.active && "bg-papel/60")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className={cx("text-base font-semibold", !s.active && "text-tinta/70")}>{s.name}</p>
                    <p className="flex items-center gap-1.5 text-sm text-tinta/70">
                      <Clock size={14} aria-hidden />
                      {durationLabel(s.durationMin, s.bufferMin)}
                    </p>
                  </div>
                  <p className="monto shrink-0 text-lg font-semibold">{s.priceLabel}</p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-tinta/10 pt-3">
                  <span className="text-sm text-tinta/70">
                    Comisión <span className="monto font-semibold text-tinta">{bpsToPercentText(s.commissionBps)} %</span>
                  </span>
                  <div className="flex items-center gap-1">
                    <ActiveToggle service={s} />
                    <Btn variant="ghost" size="md" onPress={() => setEditing({ mode: "edit", service: s })} aria-label={`Editar ${s.name}`}>
                      <Pencil size={16} aria-hidden />
                      Editar
                    </Btn>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {/* Tablet y escritorio: tabla */}
          <div className={cx(card, "hidden overflow-hidden md:block")}>
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Servicios del catálogo</caption>
              <thead className="border-b border-tinta/10 text-xs uppercase tracking-[0.12em] text-tinta/70">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold">Servicio</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Duración</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Precio</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Comisión</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Estado</th>
                  <th scope="col" className="px-5 py-3"><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-tinta/10">
                {services.map((s) => (
                  <tr key={s.id} className="transition-colors hover:bg-hueso/60">
                    <th scope="row" className={cx("px-5 py-3 font-semibold", !s.active && "text-tinta/70")}>{s.name}</th>
                    <td className="px-4 py-3 text-tinta/80">{durationLabel(s.durationMin, s.bufferMin)}</td>
                    <td className="monto px-4 py-3 text-right font-semibold">{s.priceLabel}</td>
                    <td className="monto px-4 py-3 text-right">{bpsToPercentText(s.commissionBps)} %</td>
                    <td className="px-4 py-1">
                      <ActiveToggle service={s} />
                    </td>
                    <td className="px-5 py-1 text-right">
                      <Btn variant="ghost" onPress={() => setEditing({ mode: "edit", service: s })} aria-label={`Editar ${s.name}`}>
                        <Pencil size={16} aria-hidden />
                        Editar
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Sheet
        isOpen={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.mode === "edit" ? "Editar servicio" : "Nuevo servicio"}
        description={editing?.mode === "edit" ? editing.service.name : "Precio, duración y comisión del barbero."}
      >
        {editing ? (
          <ServiceForm
            key={editing.mode === "edit" ? editing.service.id : "new"}
            service={editing.mode === "edit" ? editing.service : null}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Sheet>
    </>
  );
}

// ─── Activo / inactivo en la lista ───────────────────────────────────────────

function ActiveToggle({ service }: { service: ServiceRow }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const isSelected = optimistic ?? service.active;

  function onChange(active: boolean) {
    setOptimistic(active);
    startTransition(async () => {
      const res = await setServiceActiveAction({ serviceId: service.id, active });
      if (res.ok) {
        toast(active ? `${service.name} vuelve a estar disponible` : `${service.name} ya no se puede agendar`);
      } else {
        toast(res.error, "error");
      }
      setOptimistic(null);
    });
  }

  return (
    <Toggle isSelected={isSelected} onChange={onChange} isDisabled={pending}>
      <span className={cx("w-16", isSelected ? "text-botella" : "text-tinta/70")}>
        <span className="sr-only">{service.name}: </span>
        {isSelected ? "Activo" : "Inactivo"}
      </span>
    </Toggle>
  );
}

// ─── Formulario ──────────────────────────────────────────────────────────────

function ServiceForm({ service, onDone }: { service: ServiceRow | null; onDone: () => void }) {
  // Crear un servicio o cambiar su precio o su comisión pide confirmar identidad (lo decide el servidor).
  const reauth = useReauth({ description: "El precio y la comisión de un servicio deciden cuánto se cobra y cuánto se le paga al barbero." });
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const invalid = useFieldErrors<"name" | "price" | "commission">();

  const [name, setName] = useState(service?.name ?? "");
  const [priceDigits, setPriceDigits] = useState(service ? (BigInt(service.priceMinor) / PESO).toString() : "");
  const [durationMin, setDurationMin] = useState(service?.durationMin ?? 30);
  const [bufferMin, setBufferMin] = useState(service?.bufferMin ?? 0);
  const [commission, setCommission] = useState(service ? bpsToPercentText(service.commissionBps) : "40");
  const [active, setActive] = useState(service?.active ?? true);

  const bps = useMemo(() => {
    try {
      const v = percentToBps(commission);
      return v <= 10_000 ? v : null;
    } catch {
      return null;
    }
  }, [commission]);

  // Vista previa con las mismas funciones de money.ts que usa el cobro: sin floats.
  const preview = useMemo(() => {
    if (!priceDigits || bps === null) return null;
    const price = fromUnits(BigInt(priceDigits));
    return { cut: format(percentOf(price, BigInt(bps), PESO)), price: format(price) };
  }, [priceDigits, bps]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const ok = invalid.check(e.currentTarget, {
      ...(name.trim().length < 2 ? { name: "Escribe un nombre de al menos 2 caracteres." } : {}),
      ...(!priceDigits ? { price: "Escribe el precio." } : {}),
      ...(bps === null ? { commission: "Debe ser un porcentaje entre 0 y 100, por ejemplo 40 o 37,5." } : {}),
    });
    if (!ok) return;

    const payload = { name, priceUnits: priceDigits, durationMin, bufferMin, commission, active };
    startTransition(async () => {
      const res = await reauth.run(() => (service ? updateServiceAction({ ...payload, serviceId: service.id }) : createServiceAction(payload)));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast(service ? "Servicio actualizado" : "Servicio creado");
      onDone();
    });
  }

  return (
    <Form onSubmit={onSubmit} className="flex flex-col gap-5" validationBehavior="aria">
      <TextField
        name="name"
        value={name}
        onChange={(v) => {
          setName(v);
          invalid.clear("name");
        }}
        isRequired
        isInvalid={!!invalid.errors.name}
        maxLength={80}
        autoFocus
        className={field.root}
      >
        <Label className={field.label}>Nombre</Label>
        <Input className={field.input} placeholder="Corte clásico" />
        <FieldMessage>{invalid.errors.name}</FieldMessage>
      </TextField>

      <TextField
        name="price"
        value={groupThousands(priceDigits)}
        onChange={(v) => {
          setPriceDigits(onlyDigits(v));
          invalid.clear("price");
        }}
        isRequired
        isInvalid={!!invalid.errors.price}
        inputMode="numeric"
        className={field.root}
      >
        <Label className={field.label}>Precio</Label>
        <div className="relative">
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base text-tinta/70">
            $
          </span>
          <Input className={cx(field.input, "monto pl-7")} placeholder="35.000" autoComplete="off" />
        </div>
        <Text slot="description" className={field.description}>
          En pesos, sin centavos.
        </Text>
        <FieldMessage>{invalid.errors.price}</FieldMessage>
      </TextField>

      <div className="grid grid-cols-1 gap-4 min-[400px]:grid-cols-2">
        <MinutesField label="Duración (min)" value={durationMin} onChange={setDurationMin} minValue={5} maxValue={480} />
        <MinutesField
          label="Limpieza (min)"
          value={bufferMin}
          onChange={setBufferMin}
          minValue={0}
          maxValue={120}
          description="Margen después del servicio."
        />
      </div>

      <TextField
        name="commission"
        value={commission}
        onChange={(v) => {
          setCommission(v);
          invalid.clear("commission");
        }}
        isRequired
        isInvalid={!!invalid.errors.commission}
        inputMode="decimal"
        className={field.root}
      >
        <Label className={field.label}>Comisión del barbero</Label>
        <div className="relative">
          <Input className={cx(field.input, "monto pr-9")} placeholder="40" autoComplete="off" />
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-base text-tinta/70">
            %
          </span>
        </div>
        <Text slot="description" className={field.description}>
          Porcentaje; acepta decimales con coma, por ejemplo 37,5.
        </Text>
        <FieldMessage>{invalid.errors.commission}</FieldMessage>
      </TextField>

      <div aria-live="polite" className="rounded-xl border border-botella/20 bg-botella/5 px-4 py-3 text-sm">
        {preview ? (
          <p>
            El barbero gana <span className="monto font-semibold">{preview.cut}</span> de{" "}
            <span className="monto font-semibold">{preview.price}</span>
          </p>
        ) : (
          <p className="text-tinta/70">Escribe precio y comisión para ver cuánto gana el barbero.</p>
        )}
      </div>

      <Toggle isSelected={active} onChange={setActive}>
        <span className="flex flex-col">
          <span>Activo</span>
          <span className="text-xs font-normal text-tinta/70">{active ? "Se puede agendar." : "Oculto al agendar; el historial se conserva."}</span>
        </span>
      </Toggle>

      <FormError message={error} />

      <p className="text-xs text-tinta/70">Aplica a cobros desde hoy; los anteriores conservan su comisión.</p>

      <div className="flex flex-col-reverse gap-2 border-t border-tinta/10 pt-4 min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onDone} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" isPending={pending}>
          {pending ? "Guardando…" : service ? "Guardar cambios" : "Crear servicio"}
        </Btn>
      </div>
      {reauth.dialog}
    </Form>
  );
}
