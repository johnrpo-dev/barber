"use client";

import { ArrowRight, HandCoins, ReceiptText } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { dayShort, plural } from "../_components/dates";
import { Btn, cx, PageHeader, Sheet } from "../_components/ui";
import { card, Chip } from "../_manage/controls";
import type { loadCommissionsOverview } from "./actions";
import { AdvanceForm } from "./_components/advance-form";

// Lista de comisiones por persona. Los montos llegan formateados del servidor; aquí no se suma
// nada. "Dar anticipo" abre el formulario; liquidar se hace en la pantalla de cada persona.

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
type Overview = OkData<Awaited<ReturnType<typeof loadCommissionsOverview>>>;
type Row = Overview["staff"][number];

export function CommissionsBoard({ view }: { view: Overview }) {
  const [advance, setAdvance] = useState(false);
  const active = view.staff.filter((s) => s.active);

  return (
    <>
      <PageHeader
        eyebrow="Pagos al personal"
        title="Comisiones"
        actions={
          view.canSettle && active.length > 0 ? (
            <Btn variant="secondary" onPress={() => setAdvance(true)}>
              <HandCoins size={18} aria-hidden /> Dar anticipo
            </Btn>
          ) : null
        }
      />

      <dl className={cx(card, "grid grid-cols-3 divide-x divide-tinta/10 text-center")}>
        <div className="flex flex-col gap-0.5 px-2 py-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-tinta/70">Comisiones</dt>
          <dd className="monto whitespace-nowrap text-sm font-semibold sm:text-lg">{view.totals.commissionOwedLabel}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-2 py-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-tinta/70">Propinas</dt>
          <dd className="monto whitespace-nowrap text-sm font-semibold sm:text-lg">{view.totals.tipsOwedLabel}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-2 py-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-tinta/70">Le deben</dt>
          <dd className="monto whitespace-nowrap text-sm font-semibold sm:text-lg">{view.totals.receivableLabel}</dd>
        </div>
      </dl>
      <p className="-mt-3 text-xs text-tinta/70">
        Lo que el negocio le debe al personal hoy, <span className="monto">{dayShort(view.businessDate)}</span>. &quot;Le deben&quot; son anticipos y saldos que se
        descuentan en la próxima liquidación.
      </p>

      {view.staff.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-tinta/20 bg-papel px-6 py-12 text-center">
          <HandCoins size={32} className="text-tinta/40" aria-hidden />
          <p className="mt-3 font-display text-2xl">Sin comisiones</p>
          <p className="mt-1 text-sm text-tinta/70">Cuando el personal cobre servicios, aquí verás lo que se le debe.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.staff.map((s) => (
            <li key={s.staffId}>
              <StaffRow row={s} />
            </li>
          ))}
        </ul>
      )}

      <Sheet isOpen={advance} onOpenChange={setAdvance} title="Dar anticipo" description="Se descuenta en la próxima liquidación de la persona.">
        {advance ? (
          <AdvanceForm staff={active.map((s) => ({ id: s.staffId, name: s.name }))} cashSessionOpen={null} onCancel={() => setAdvance(false)} />
        ) : null}
      </Sheet>
    </>
  );
}

function StaffRow({ row: s }: { row: Row }) {
  return (
    <article className={cx(card, "flex flex-col")} aria-labelledby={`staff-${s.staffId}`}>
      <Link
        href={`/panel/comisiones/${s.staffId}`}
        className="flex flex-col gap-3 rounded-xl p-4 outline-none hover:bg-tinta/[0.03] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cuero"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={`staff-${s.staffId}`} className="break-words text-lg font-semibold leading-snug">
              {s.name}
            </h2>
            {s.active ? null : (
              <span className="self-start">
                <Chip tone="muted">Inactivo</Chip>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex flex-col items-end">
              <span className="monto shrink-0 whitespace-nowrap font-display text-2xl leading-tight">{s.estimatedPayoutLabel}</span>
              <span className="text-[11px] text-tinta/70">pago estimado</span>
            </div>
            <ArrowRight size={18} className="text-tinta/60" aria-hidden />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <div className="flex flex-col">
            <dt className="text-xs text-tinta/70">Comisión pendiente</dt>
            <dd className="monto font-semibold">
              {s.pendingCommissionLabel}
              <span className="ml-1 text-xs font-normal text-tinta/70">({plural(s.pendingLines, "servicio", "servicios")})</span>
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-tinta/70">Propinas por pagar</dt>
            <dd className="monto font-semibold">{s.tipsOwedLabel}</dd>
          </div>
          {s.clawbacksMinor !== "0" ? (
            <div className="flex flex-col">
              <dt className="text-xs text-tinta/70">Anulaciones por descontar</dt>
              <dd className="monto font-semibold text-alerta">−{s.clawbacksLabel}</dd>
            </div>
          ) : null}
          {s.receivableMinor !== "0" ? (
            <div className="flex flex-col">
              <dt className="text-xs text-tinta/70">Debe (anticipos)</dt>
              <dd className="monto font-semibold text-alerta">−{s.receivableLabel}</dd>
            </div>
          ) : null}
        </dl>
      </Link>
      {s.lastSettlement ? (
        <div className="flex items-center gap-2 border-t border-tinta/10 px-4 py-2.5 text-xs text-tinta/70">
          <ReceiptText size={14} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex-1">
            Última liquidación{" "}
            <Link
              href={`/panel/comprobantes/${s.lastSettlement.publicId}`}
              className="font-semibold text-cuero underline-offset-2 hover:underline focus-visible:outline-3 focus-visible:outline-cuero"
            >
              {s.lastSettlement.numberLabel}
            </Link>{" "}
            · corte <span className="monto">{dayShort(s.lastSettlement.cutoffDate)}</span> · <span className="monto whitespace-nowrap">{s.lastSettlement.payoutLabel}</span>
          </span>
        </div>
      ) : (
        <p className="border-t border-tinta/10 px-4 py-2.5 text-xs text-tinta/70">Todavía no tiene liquidaciones.</p>
      )}
    </article>
  );
}
