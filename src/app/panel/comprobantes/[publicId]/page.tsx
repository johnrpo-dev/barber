import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireStaff } from "@/lib/session";
import { dayLabel, dayShort, momentLabel } from "../../_components/dates";
import { PageHeader } from "../../_components/ui";
import { FormError } from "../../_manage/controls";
import { loadReceipt } from "../actions";
import { ReceiptToolbar } from "./receipt-toolbar";

export const metadata: Metadata = { title: "Comprobante · Villa" };

// Comprobante de una liquidación o de un anticipo (docs/sprint-5-comisiones-informes.md §10).
// El acceso lo decide loadReceipt: el dueño ve cualquiera de la sede y el barbero solo los suyos;
// un id que no es ULID, que no existe o que no es de quien mira da 404 (notFound), igual en todos.
// Sin datos de clientes. La hoja de impresión: una columna de 560 px como máximo, legible en A4 y
// en tirilla de 80 mm; el borde perforado en latón es decorativo (ningún texto va en latón).

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
type Receipt = OkData<Awaited<ReturnType<typeof loadReceipt>>>;

const cell = "border-b border-tinta/10 py-1.5 align-top print:py-1";

export default async function ReceiptPage({ params }: { params: Promise<{ publicId: string }> }) {
  await requireStaff();
  const { publicId } = await params;
  const result = await loadReceipt({ publicId });
  if (!result.ok) {
    return (
      <main className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-4 pb-28 pt-6">
        <PageHeader title="Comprobante" />
        <FormError message={result.error} />
      </main>
    );
  }
  const r = result.data;
  const title = r.kind === "settlement" ? `Comprobante de pago de comisiones ${r.numberLabel}` : `Comprobante de anticipo ${r.numberLabel}`;
  const reversed = r.status === "reversed";

  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-4 pb-28 pt-6 md:py-10 print:max-w-none print:gap-0 print:p-0">
      <ReceiptToolbar title={title} />

      <article
        aria-labelledby="comprobante-titulo"
        className="relative overflow-hidden rounded-xl border border-tinta/10 bg-papel shadow-sm print:overflow-visible print:rounded-none print:border-0 print:bg-white print:shadow-none"
      >
        {/* Borde perforado de tirilla: solo decoración. */}
        <div aria-hidden className="h-2 bg-[radial-gradient(circle,var(--color-laton)_2px,transparent_2.5px)] bg-[length:10px_8px] bg-center print:hidden" />

        <div className="flex flex-col gap-5 px-5 py-6 text-sm print:gap-3 print:px-0 print:py-0 print:text-[11px]">
          <header className="flex flex-col gap-1 border-b border-dashed border-tinta/30 pb-4 text-center print:pb-2">
            <p className="font-display text-2xl leading-tight print:text-lg">{r.locationName}</p>
            <h1 id="comprobante-titulo" className="text-base font-semibold leading-snug print:text-sm">
              {title}
            </h1>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-left">
              <dt className="text-tinta/70">{r.kind === "settlement" ? "Barbero" : "Para"}</dt>
              <dd className="font-semibold">{r.staffName}</dd>
              {r.period ? (
                <>
                  <dt className="text-tinta/70">Periodo</dt>
                  <dd className="monto">
                    {r.period.fromDate && r.period.fromDate !== r.period.cutoffDate ? `${dayLabel(r.period.fromDate)} al ` : "Hasta el "}
                    {dayLabel(r.period.cutoffDate)}
                  </dd>
                </>
              ) : null}
              <dt className="text-tinta/70">Fecha de pago</dt>
              <dd className="monto">{dayLabel(r.businessDate)}</dd>
              <dt className="text-tinta/70">Pagado desde</dt>
              <dd>{r.paidFromLabel ?? "Sin movimiento de dinero"}</dd>
            </dl>
          </header>

          {reversed && r.reversal ? (
            <div role="note" className="flex flex-col items-center gap-1 text-center">
              <p className="-rotate-3 rounded-md border-4 border-double border-alerta px-4 py-1 font-display text-3xl tracking-[0.2em] text-alerta print:text-2xl">
                REVERTID{r.kind === "settlement" ? "A" : "O"}
              </p>
              <p className="text-xs text-tinta/80">
                <span className="monto">{momentLabel(r.reversal.atLabel)}</span> · {r.reversal.by}
              </p>
              <p className="text-xs text-tinta/80">Motivo: {r.reversal.reason}</p>
            </div>
          ) : null}

          {r.kind === "settlement" ? <SettlementBody r={r} /> : <AdvanceBody r={r} />}

          {r.note ? (
            <p className="text-tinta/80">
              <span className="font-semibold text-tinta">Nota: </span>
              {r.note}
            </p>
          ) : null}

          <footer className="flex flex-col gap-5 border-t border-dashed border-tinta/30 pt-4 print:gap-4 print:pt-2">
            <p className="font-semibold">Recibí conforme</p>
            <div className="grid grid-cols-1 gap-6 min-[400px]:grid-cols-2 print:grid-cols-2 print:gap-4">
              <div className="flex flex-col gap-1">
                <span className="block h-10 border-b border-tinta/60" aria-hidden />
                <span className="text-xs text-tinta/70">Firma</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="block h-10 border-b border-tinta/60" aria-hidden />
                <span className="text-xs text-tinta/70">C.C.</span>
              </div>
            </div>
            <p className="text-xs text-tinta/70">
              Registró {r.createdBy} · <span className="monto">{momentLabel(r.createdAtLabel)}</span>
            </p>
            <p className="break-all font-mono text-[11px] text-tinta/70">{r.publicId}</p>
          </footer>
        </div>

        <div aria-hidden className="h-2 bg-[radial-gradient(circle,var(--color-laton)_2px,transparent_2.5px)] bg-[length:10px_8px] bg-center print:hidden" />
      </article>
    </main>
  );
}

function SettlementBody({ r }: { r: Receipt }) {
  return (
    <div className="flex flex-col gap-4 print:gap-2">
      <div>
        <table className="w-full border-collapse text-left">
          <caption className="pb-1.5 text-left text-xs font-semibold uppercase tracking-[0.14em] text-tinta/70">Comisiones</caption>
          <thead>
            <tr className="text-xs text-tinta/70">
              <th scope="col" className={`${cell} pr-2 font-semibold`}>
                Fecha
              </th>
              <th scope="col" className={`${cell} pr-2 font-semibold`}>
                Servicio
              </th>
              <th scope="col" className={`${cell} hidden pr-2 text-right font-semibold sm:table-cell`}>
                Neto
              </th>
              <th scope="col" className={`${cell} hidden pr-2 text-right font-semibold sm:table-cell`}>
                %
              </th>
              <th scope="col" className={`${cell} text-right font-semibold`}>
                Comisión
              </th>
            </tr>
          </thead>
          <tbody>
            {r.commissions.length === 0 ? (
              <tr>
                <td colSpan={5} className={`${cell} text-tinta/70`}>
                  Sin comisiones en este periodo.
                </td>
              </tr>
            ) : (
              r.commissions.map((c, i) => (
                <tr key={i}>
                  <td className={`${cell} monto whitespace-nowrap pr-2`}>{dayShort(c.businessDate)}</td>
                  <td className={`${cell} pr-2`}>
                    {c.description}
                    {/* Angosto (celular o tirilla): neto y % bajo el servicio; así la comisión siempre se ve. */}
                    <span className="monto block text-xs text-tinta/70 sm:hidden">
                      <span className="whitespace-nowrap">{c.netLabel}</span> · <span className="whitespace-nowrap">{c.rateLabel}</span>
                    </span>
                  </td>
                  <td className={`${cell} monto hidden whitespace-nowrap pr-2 text-right sm:table-cell`}>{c.netLabel}</td>
                  <td className={`${cell} monto hidden whitespace-nowrap pr-2 text-right sm:table-cell`}>{c.rateLabel}</td>
                  <td className={`${cell} monto whitespace-nowrap text-right`}>{c.commissionLabel}</td>
                </tr>
              ))
            )}
          </tbody>
          {r.totals ? (
            <tfoot>
              <tr>
                <th scope="row" colSpan={2} className="py-1.5 pr-2 text-left font-semibold">
                  Total comisiones
                </th>
                <td colSpan={2} className="hidden sm:table-cell" />
                <td className="monto whitespace-nowrap py-1.5 text-right font-semibold">{r.totals.commissionLabel}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {r.clawbacks.length > 0 ? (
        <table className="w-full border-collapse text-left">
          <caption className="pb-1.5 text-left text-xs font-semibold uppercase tracking-[0.14em] text-tinta/70">Anulaciones de ventas ya liquidadas</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Fecha</th>
              <th scope="col">Servicio y liquidación donde se pagó</th>
              <th scope="col">Descuento</th>
            </tr>
          </thead>
          <tbody>
            {r.clawbacks.map((c, i) => (
              <tr key={i}>
                <td className={`${cell} monto whitespace-nowrap pr-2`}>{dayShort(c.businessDate)}</td>
                <td className={`${cell} pr-2`}>
                  {c.description}
                  {c.settlementNumberLabel ? <span className="text-tinta/70"> (pagada en {c.settlementNumberLabel})</span> : null}
                </td>
                <td className={`${cell} monto whitespace-nowrap text-right`}>−{c.amountLabel}</td>
              </tr>
            ))}
          </tbody>
          {r.totals ? (
            <tfoot>
              <tr>
                <th scope="row" colSpan={2} className="py-1.5 pr-2 text-right font-semibold">
                  Total anulaciones
                </th>
                <td className="monto whitespace-nowrap py-1.5 text-right font-semibold">−{r.totals.clawbackLabel}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      ) : null}

      <table className="w-full border-collapse text-left">
        <caption className="pb-1.5 text-left text-xs font-semibold uppercase tracking-[0.14em] text-tinta/70">Liquidación</caption>
        <tbody>
          {r.totals ? <SumRow label="Comisiones" value={r.totals.commissionLabel} /> : null}
          {r.totals && r.clawbacks.length > 0 ? <SumRow label="Anulaciones ya liquidadas" value={`−${r.totals.clawbackLabel}`} /> : null}
          {r.tipsLabel ? <SumRow label="Propinas" value={r.tipsLabel} /> : null}
          {r.adjustments.map((a, i) => (
            <SumRow
              key={i}
              label={
                <>
                  {a.direction === "add" ? "Bono" : "Descuento"}: <span className="text-tinta/80">{a.reason}</span>
                </>
              }
              value={`${a.direction === "add" ? "+" : "−"}${a.amountLabel}`}
            />
          ))}
          {r.totals ? <SumRow label="Ganado" value={r.totals.grossLabel} strong /> : null}
          {r.advanceDeductionLabel ? <SumRow label="Anticipos descontados" value={`−${r.advanceDeductionLabel}`} /> : null}
          {r.carryOverLabel ? <SumRow label="Queda debiendo (se descuenta en la próxima)" value={r.carryOverLabel} /> : null}
        </tbody>
        {r.totals ? (
          <tfoot>
            <tr>
              <th scope="row" className="border-t-2 border-tinta pt-2 text-left text-base font-semibold print:text-sm">
                Total pagado
              </th>
              <td className="monto whitespace-nowrap border-t-2 border-tinta pt-2 text-right font-display text-2xl print:text-lg">{r.totals.payoutLabel}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function AdvanceBody({ r }: { r: Receipt }) {
  if (!r.advance) return null;
  return (
    <table className="w-full border-collapse text-left">
      <caption className="pb-1.5 text-left text-xs font-semibold uppercase tracking-[0.14em] text-tinta/70">Anticipo</caption>
      <tbody>
        <SumRow label="Motivo" value={r.advance.reason} plain />
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" className="border-t-2 border-tinta pt-2 text-left text-base font-semibold print:text-sm">
            Total entregado
          </th>
          <td className="monto whitespace-nowrap border-t-2 border-tinta pt-2 text-right font-display text-2xl print:text-lg">{r.advance.amountLabel}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function SumRow({ label, value, strong, plain }: { label: ReactNode; value: string; strong?: boolean; plain?: boolean }) {
  return (
    <tr>
      <th scope="row" className={`${cell} pr-3 text-left ${strong ? "font-semibold" : "font-normal"}`}>
        {label}
      </th>
      <td className={`${cell} text-right ${plain ? "" : "monto whitespace-nowrap"} ${strong ? "font-semibold" : ""}`}>{value}</td>
    </tr>
  );
}
