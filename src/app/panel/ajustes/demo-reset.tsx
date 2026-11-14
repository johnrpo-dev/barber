"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Form, Input, Label, Text, TextField } from "react-aria-components";
import { callAction } from "../_components/money-field";
import { useReauth } from "../_components/reauth";
import { Btn, cx, field, Sheet, SheetFooter, useToast } from "../_components/ui";
import { card, FormError } from "../_manage/controls";
import { resetDemoDataAction } from "./demo-actions";

// "Empezar de cero" en la demo (docs/demo.md). La página solo lo muestra con la app en modo demo
// (npm run demo); el servidor vuelve a revisar el modo, el permiso, la palabra y la identidad, y la
// base revisa que sea la de práctica. En la base de la barbería este bloque no existe.

const CONFIRMATION = "BORRAR";

export function DemoReset() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="demo-reset" className={cx(card, "flex flex-col gap-4 border-alerta/40 p-5")}>
      <div className="flex flex-col gap-1">
        <h2 id="demo-reset" className="font-display text-2xl leading-tight">
          Demo: empezar de cero
        </h2>
        <p className="max-w-prose text-sm text-tinta/70">
          Solo aparece en la demo. Borra toda la operación y deja la configuración, para practicar desde el primer día. Para volver a tener un mes de
          datos, corre <code className="font-mono text-xs">npm run demo:setup</code> en el computador.
        </p>
      </div>
      <Btn variant="danger" className="self-start" onPress={() => setOpen(true)}>
        <RotateCcw size={18} aria-hidden />
        Borrar todos los registros
      </Btn>
      <Sheet isOpen={open} onOpenChange={setOpen} title="Borrar todos los registros" description="Base de la demo">
        {open ? <ResetForm onCancel={() => setOpen(false)} onDone={() => setOpen(false)} /> : null}
      </Sheet>
    </section>
  );
}

function ResetForm({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const reauth = useReauth({ description: "Borrar los registros de la demo no se puede deshacer." });
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (confirmation.trim() !== CONFIRMATION) return setError(`Escribe ${CONFIRMATION} para confirmar.`);
    setPending(true);
    const r = await callAction(() => reauth.run(() => resetDemoDataAction({ confirmation: CONFIRMATION })));
    setPending(false);
    if (!r.ok) return setError(r.error);
    toast("Listo: la demo quedó en cero");
    onDone();
    router.refresh();
  }

  return (
    <Form onSubmit={onSubmit} validationBehavior="aria" className="flex flex-col gap-4 text-sm text-tinta/80">
      <p className="font-semibold text-alerta">Esto no se puede deshacer.</p>

      <div className="flex flex-col gap-1">
        <p className="font-semibold text-tinta">Se borra</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Citas, clientes, ventas y recibos.</li>
          <li>Turnos de caja, gastos, cierres del día y el libro contable.</li>
          <li>Compras, proveedores y lo que se les debe; anticipos y liquidaciones.</li>
          <li>Anulaciones, avisos, alertas y la bitácora.</li>
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <p className="font-semibold text-tinta">Se conserva</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>La sede y sus reglas, servicios y productos (sin existencias).</li>
          <li>El personal con sus horarios y las cuentas de acceso (tu sesión sigue abierta).</li>
          <li>Medios de pago, categorías de gasto y plantillas de gastos fijos.</li>
        </ul>
      </div>

      <TextField value={confirmation} onChange={setConfirmation} isRequired className={field.root}>
        <Label className={field.label}>Escribe {CONFIRMATION} para confirmar</Label>
        <Input className={field.input} autoComplete="off" autoCapitalize="characters" />
        <Text slot="description" className={field.description}>
          Te pediremos tu contraseña y tu código si no los confirmaste hace poco.
        </Text>
      </TextField>

      <FormError message={error} />

      <SheetFooter className="flex-col-reverse min-[400px]:flex-row min-[400px]:justify-end">
        <Btn variant="secondary" onPress={onCancel} isDisabled={pending}>
          Cancelar
        </Btn>
        <Btn type="submit" variant="danger" isPending={pending}>
          <RotateCcw size={18} aria-hidden />
          {pending ? "Borrando…" : "Borrar todo"}
        </Btn>
      </SheetFooter>
      {reauth.dialog}
    </Form>
  );
}
