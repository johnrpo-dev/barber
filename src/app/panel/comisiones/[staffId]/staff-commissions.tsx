"use client";

import { ArrowLeft, HandCoins, ReceiptText, Undo2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { dayShort } from "../../_components/dates";
import { callAction } from "../../_components/money-field";
import { Btn, cx, PageHeader, Sheet, useToast } from "../../_components/ui";
import { card, Chip } from "../../_manage/controls";
import { AdvanceForm } from "../_components/advance-form";
import { ReverseForm } from "../_components/reverse-form";
import { loadStaffCommissions } from "../actions";
import { SettlementForm } from "./settlement-form";

// Pantalla de una persona: liquidar (vista previa del servidor), dar anticipos y revisar el
// historial con "Revertir" solo donde el servidor lo permite (canReverse).

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
type View = OkData<Awaited<ReturnType<typeof loadStaffCommissions>>>;
type Reversing =
  | { kind: "settlement"; item: View["settlements"][number] }
  | { kind: "advance"; item: View["advances"][number] }
  | null;

export function StaffCommissions({ initial, canSettle }: { initial: View; canSettle: boolean }) {
  const toast = useToast();
  const [view, setView] = useState(initial);
  const [advance, setAdvance] = useState(false);
  const [reversing, setReversing] = useState<Reversing>(null);
  /** Cambia tras una reversa: la vista previa se vuelve a pedir. */
  const [refreshNonce, setRefreshNonce] = useState(0);

  const refresh = useCallback(async () => {
    const r = await callAction(() => loadStaffCommissions({ staffId: initial.staff.id }));
    if (r.ok) setView(r.data);
    else toast(r.error, "error");
    setRefreshNonce((n) => n + 1);
  }, [initial.staff.id, toast]);

  return (
    <>
      <Link
        href="/panel/comisiones"
        className="-mb-3 inline-flex items-center gap-1.5 self-start rounded-md text-sm font-semibold text-cuero outline-none hover:underline focus-visible:outline-3 focus-visible:outline-cuero"
      >
        <ArrowLeft size={16} aria-hidden /> Comisiones
      </Link>
      <PageHeader
        eyebrow="Comisiones"
        title={view.staff.name}
        actions={
          canSettle && view.staff.active ? (
            <Btn variant="secondary" onPress={() => setAdvance(true)}>
              <HandCoins size={18} aria-hidden /> Dar anticipo
            </Btn>
          ) : null
        }
      />
      {view.staff.active ? null : (
        <p className="-mt-3 text-sm text-tinta/70">Esta persona está inactiva. Puedes liquidarle lo pendiente.</p>
      )}

      {canSettle ? (
        <section className={cx(card, "p-4 md:p-6")}>
          <SettlementForm
            refreshNonce={refreshNonce}
            ctx={{
              staff: { id: view.staff.id, name: view.staff.name },
              businessDate: view.businessDate,
              dayClosed: view.dayClosed,
              cashSessionOpen: view.cashSessionOpen,
              lastCutoffDate: view.lastCutoffDate,
              suggestedCutoffDate: view.suggestedCutoffDate,
            }}
          />
        </section>
      ) : null}

      {/* Historial de liquidaciones */}
      <section aria-labelledby="liquidaciones" className="flex flex-col gap-3">
        <h2 id="liquidaciones" className="font-display text-2xl leading-tight">
          Liquidaciones
        </h2>
        {view.settlements.length === 0 ? (
          <p className="text-sm text-tinta/70">Todavía no tiene liquidaciones.</p>
        ) : (
          <ul className={cx(card, "divide-y divide-tinta/10")}>
            {view.settlements.map((s) => (
              <li key={s.publicId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <Link
                  href={`/panel/comprobantes/${s.publicId}`}
                  className="flex min-w-0 flex-1 basis-60 items-center gap-3 rounded-md outline-none focus-visible:outline-3 focus-visible:outline-cuero"
                >
                  <ReceiptText size={18} className="shrink-0 text-tinta/60" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      {s.numberLabel} <span className="sr-only">, ver comprobante</span>
                    </span>
                    <span className="monto block text-xs text-tinta/70">
                      Corte {dayShort(s.cutoffDate)} · pagada {dayShort(s.businessDate)}
                      {s.paidFromLabel ? ` · ${s.paidFromLabel}` : ""}
                    </span>
                  </span>
                  <span className={cx("monto shrink-0 whitespace-nowrap font-semibold", s.status === "reversed" && "text-tinta/60 line-through")}>{s.payoutLabel}</span>
                </Link>
                {s.status === "reversed" ? (
                  <span className="ml-auto"><Chip tone="muted">Revertida</Chip></span>
                ) : canSettle && s.canReverse ? (
                  <Btn variant="ghost" size="sm" className="ml-auto h-11 text-alerta" onPress={() => setReversing({ kind: "settlement", item: s })}>
                    <Undo2 size={16} aria-hidden /> Revertir
                  </Btn>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Anticipos */}
      <section aria-labelledby="anticipos" className="flex flex-col gap-3">
        <h2 id="anticipos" className="font-display text-2xl leading-tight">
          Anticipos
        </h2>
        {view.advances.length === 0 ? (
          <p className="text-sm text-tinta/70">No tiene anticipos.</p>
        ) : (
          <ul className={cx(card, "divide-y divide-tinta/10")}>
            {view.advances.map((a) => (
              <li key={a.publicId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <Link
                  href={`/panel/comprobantes/${a.publicId}`}
                  className="flex min-w-0 flex-1 basis-60 items-center gap-3 rounded-md outline-none focus-visible:outline-3 focus-visible:outline-cuero"
                >
                  <HandCoins size={18} className="shrink-0 text-tinta/60" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      {a.numberLabel} <span className="sr-only">, ver comprobante</span>
                    </span>
                    <span className="block text-xs text-tinta/70">
                      <span className="monto">{dayShort(a.businessDate)}</span> · {a.paidFromLabel} · {a.reason}
                    </span>
                  </span>
                  <span className={cx("monto shrink-0 whitespace-nowrap font-semibold", a.status === "reversed" && "text-tinta/60 line-through")}>{a.amountLabel}</span>
                </Link>
                {a.status === "reversed" ? (
                  <span className="ml-auto"><Chip tone="muted">Revertido</Chip></span>
                ) : canSettle && a.canReverse ? (
                  <Btn variant="ghost" size="sm" className="ml-auto h-11 text-alerta" onPress={() => setReversing({ kind: "advance", item: a })}>
                    <Undo2 size={16} aria-hidden /> Revertir
                  </Btn>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Sheet isOpen={advance} onOpenChange={setAdvance} title="Dar anticipo" description={`Para ${view.staff.name}. Se descuenta en su próxima liquidación.`}>
        {advance ? (
          <AdvanceForm
            fixedStaff={{ id: view.staff.id, name: view.staff.name }}
            cashSessionOpen={view.cashSessionOpen}
            onCancel={() => setAdvance(false)}
          />
        ) : null}
      </Sheet>

      <Sheet
        isOpen={reversing !== null}
        onOpenChange={(o) => !o && setReversing(null)}
        title={reversing?.kind === "advance" ? "Revertir anticipo" : "Revertir liquidación"}
        description={reversing ? `${reversing.item.numberLabel} de ${view.staff.name}` : undefined}
      >
        {reversing ? (
          <ReverseForm
            key={reversing.item.publicId}
            kind={reversing.kind}
            publicId={reversing.item.publicId}
            numberLabel={reversing.item.numberLabel}
            amountLabel={reversing.kind === "settlement" ? reversing.item.payoutLabel : reversing.item.amountLabel}
            paidFromLabel={reversing.item.paidFromLabel}
            onCancel={() => setReversing(null)}
            onDone={(message) => {
              setReversing(null);
              toast(message);
              void refresh();
            }}
          />
        ) : null}
      </Sheet>
    </>
  );
}
