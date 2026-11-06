"use client";

import { Globe } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import { Form, Input, Label, Radio, RadioGroup, Text, TextField } from "react-aria-components";
import { Btn, cx, field, PageHeader, useToast } from "../_components/ui";
import { card, FormError, MinutesField, radioCard, Toggle } from "../_manage/controls";
import { setStaffBookableAction, updateBookingSettingsAction } from "./actions";

export interface SettingsView {
  name: string;
  publicBookingEnabled: boolean;
  bookingRequiresCode: boolean;
  publicPhone: string;
  address: string | null;
  mapsUrl: string | null;
  slotStepMin: number;
  minAdvanceMin: number;
  maxAdvanceDays: number;
  holdMin: number;
  freeCancelHours: number;
  noShowGraceMin: number;
  maxActivePerClient: number;
  walkInGuardMin: number;
  noShowLimit: number;
  taxId: string | null;
  receiptFooter: string | null;
}

export interface BookableRow {
  id: string;
  name: string;
  bookable: boolean;
}

const STEPS = [5, 10, 15, 20, 30] as const;

export function SettingsForm({ settings, staff }: { settings: SettingsView; staff: BookableRow[] }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [s, setS] = useState({
    ...settings,
    address: settings.address ?? "",
    mapsUrl: settings.mapsUrl ?? "",
    taxId: settings.taxId ?? "",
    receiptFooter: settings.receiptFooter ?? "",
  });
  const set = <K extends keyof typeof s>(key: K) => (value: (typeof s)[K]) => setS((prev) => ({ ...prev, [key]: value }));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const { name: _name, ...payload } = s;
    startTransition(async () => {
      const res = await updateBookingSettingsAction(payload);
      if (!res.ok) return setError(res.error);
      toast(s.publicBookingEnabled ? "Ajustes guardados. La reserva en línea está abierta." : "Ajustes guardados");
    });
  }

  return (
    <>
      <PageHeader eyebrow={settings.name} title="Ajustes" />

      <Form onSubmit={onSubmit} className="flex flex-col gap-6" validationBehavior="aria">
        <section aria-labelledby="reserva-en-linea" className={cx(card, "flex flex-col gap-5 p-5")}>
          <div className="flex flex-col gap-1">
            <h2 id="reserva-en-linea" className="font-display text-2xl leading-tight">
              Reserva en línea
            </h2>
            <p className="max-w-prose text-sm text-tinta/70">
              Los clientes reservan desde el celular y confirman con un código. Mientras esté apagada, la página pública muestra el teléfono.
            </p>
          </div>
          <Toggle isSelected={s.publicBookingEnabled} onChange={set("publicBookingEnabled")}>
            <span className="flex flex-col">
              <span className="inline-flex items-center gap-2">
                <Globe size={16} aria-hidden />
                {s.publicBookingEnabled ? "Abierta al público" : "Cerrada"}
              </span>
              <span className="text-xs font-normal text-tinta/70">Requiere WhatsApp o correo y la verificación anti-robots configurados.</span>
            </span>
          </Toggle>
          <Toggle isSelected={s.bookingRequiresCode} onChange={set("bookingRequiresCode")}>
            <span className="flex flex-col">
              <span>{s.bookingRequiresCode ? "Pide código por WhatsApp al reservar" : "Reserva sin código"}</span>
              <span className="text-xs font-normal text-tinta/70">
                Sin código la reserva es más rápida, pero cualquiera puede reservar con un número ajeno. Enciéndelo si aparecen reservas falsas.
              </span>
            </span>
          </Toggle>
          <TextField value={s.publicPhone} onChange={set("publicPhone")} maxLength={30} className={field.root}>
            <Label className={field.label}>Teléfono o WhatsApp de la sede</Label>
            <Input className={cx(field.input, "monto")} inputMode="tel" placeholder="300 123 4567" autoComplete="off" />
            <Text slot="description" className={field.description}>
              Si es celular, la página ofrece escribir por WhatsApp.
            </Text>
          </TextField>
          <TextField value={s.address} onChange={set("address")} maxLength={200} className={field.root}>
            <Label className={field.label}>Dirección</Label>
            <Input className={field.input} placeholder="Calle 10 # 5-20, Barrio Centro" autoComplete="off" />
          </TextField>
          <TextField value={s.mapsUrl} onChange={set("mapsUrl")} maxLength={500} type="url" className={field.root}>
            <Label className={field.label}>Enlace de Google Maps (opcional)</Label>
            <Input className={field.input} inputMode="url" placeholder="https://maps.app.goo.gl/…" autoComplete="off" />
          </TextField>
        </section>

        <section aria-labelledby="reglas" className={cx(card, "flex flex-col gap-5 p-5")}>
          <div className="flex flex-col gap-1">
            <h2 id="reglas" className="font-display text-2xl leading-tight">
              Reglas de la agenda
            </h2>
            <p className="max-w-prose text-sm text-tinta/70">Aplican a la reserva en línea; la recepción puede agendar sin ellas.</p>
          </div>
          <RadioGroup
            value={String(s.slotStepMin)}
            onChange={(v) => set("slotStepMin")(Number(v))}
            orientation="horizontal"
            className={field.root}
          >
            <Label className={field.label}>Ofrecer turnos cada</Label>
            <div className="grid grid-cols-5 gap-2">
              {STEPS.map((m) => (
                <Radio key={m} value={String(m)} className={cx(radioCard, "justify-center px-1")}>
                  <span className="monto">{m}</span>
                  <span className="sr-only"> minutos</span>
                </Radio>
              ))}
            </div>
          </RadioGroup>
          <div className="grid grid-cols-1 gap-4 min-[400px]:grid-cols-2">
            <MinutesField
              label="Anticipación mínima (min)"
              value={s.minAdvanceMin}
              onChange={set("minAdvanceMin")}
              minValue={0}
              maxValue={1440}
              step={15}
              description="Nadie reserva para dentro de menos tiempo."
            />
            <MinutesField
              label="Días hacia adelante"
              value={s.maxAdvanceDays}
              onChange={set("maxAdvanceDays")}
              minValue={1}
              maxValue={60}
              step={1}
            />
            <MinutesField
              label="Tiempo para confirmar (min)"
              value={s.holdMin}
              onChange={set("holdMin")}
              minValue={10}
              maxValue={30}
              description="Cuánto se guarda el horario mientras llega el código."
            />
            <MinutesField
              label="Cancelar sin penalidad (horas antes)"
              value={s.freeCancelHours}
              onChange={set("freeCancelHours")}
              minValue={0}
              maxValue={72}
              step={1}
            />
            <MinutesField
              label="Tolerancia de llegada (min)"
              value={s.noShowGraceMin}
              onChange={set("noShowGraceMin")}
              minValue={0}
              maxValue={60}
              description="Después se puede marcar «No vino»."
            />
            <MinutesField
              label="Citas activas por cliente"
              value={s.maxActivePerClient}
              onChange={set("maxActivePerClient")}
              minValue={1}
              maxValue={10}
              step={1}
            />
            <MinutesField
              label="Faltas para suspender la reserva"
              value={s.noShowLimit}
              onChange={set("noShowLimit")}
              minValue={1}
              maxValue={10}
              step={1}
              description="Con este número de «No vino», el cliente ya no reserva en línea hasta que recepción lo desbloquee."
            />
            <MinutesField
              label="Walk-in: sin cita en los próximos (min)"
              value={s.walkInGuardMin}
              onChange={set("walkInGuardMin")}
              minValue={0}
              maxValue={240}
              description="Un barbero con una cita más cerca que esto no recibe clientes sin cita."
            />
          </div>
        </section>

        <section aria-labelledby="recibo" className={cx(card, "flex flex-col gap-5 p-5")}>
          <div className="flex flex-col gap-1">
            <h2 id="recibo" className="font-display text-2xl leading-tight">
              Recibo
            </h2>
            <p className="max-w-prose text-sm text-tinta/70">
              Lo que sale en el recibo impreso, además del nombre, la dirección y el teléfono de la sede. El recibo no es una factura electrónica.
            </p>
          </div>
          <TextField value={s.taxId} onChange={set("taxId")} maxLength={30} className={field.root}>
            <Label className={field.label}>NIT o cédula (opcional)</Label>
            <Input className={cx(field.input, "monto")} inputMode="numeric" placeholder="900.123.456-7" autoComplete="off" />
          </TextField>
          <TextField value={s.receiptFooter} onChange={set("receiptFooter")} maxLength={200} className={field.root}>
            <Label className={field.label}>Mensaje al pie (opcional)</Label>
            <Input className={field.input} placeholder="¡Gracias por venir!" autoComplete="off" />
          </TextField>
        </section>

        <FormError message={error} />
        <div className="flex justify-end">
          <Btn type="submit" isPending={pending} className="w-full min-[400px]:w-auto">
            {pending ? "Guardando…" : "Guardar ajustes"}
          </Btn>
        </div>
      </Form>

      <section aria-labelledby="en-linea" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="en-linea" className="font-display text-2xl leading-tight">
            Quién atiende en línea
          </h2>
          <p className="max-w-prose text-sm text-tinta/70">Quien esté apagado no aparece en la reserva pública; la recepción sí puede agendarle.</p>
        </div>
        <ul className={cx(card, "divide-y divide-tinta/10")}>
          {staff.map((m) => (
            <BookableToggle key={m.id} member={m} />
          ))}
        </ul>
      </section>
    </>
  );
}

function BookableToggle({ member }: { member: BookableRow }) {
  const toast = useToast();
  const [on, setOn] = useState(member.bookable);
  const [pending, startTransition] = useTransition();
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2">
      <span className="font-medium">{member.name}</span>
      <Toggle
        isSelected={on}
        isDisabled={pending}
        aria-label={`${member.name} en la reserva en línea`}
        onChange={(value) => {
          setOn(value);
          startTransition(async () => {
            const res = await setStaffBookableAction({ staffId: member.id, bookable: value });
            if (!res.ok) {
              setOn(!value);
              toast(res.error, "error");
            }
          });
        }}
      />
    </li>
  );
}
