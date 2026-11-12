import type { Metadata } from "next";
import { ReceiptToolbar } from "../../comprobantes/[publicId]/receipt-toolbar";
import { dayLabel } from "../../_components/dates";
import { PageHeader } from "../../_components/ui";
import { FormError } from "../../_manage/controls";
import { loadSaleReceipt } from "../actions";

export const metadata: Metadata = { title: "Recibo · Villa" };

// Recibo de una venta, en formato de tirilla (58 u 80 mm) y legible en A4. No es factura
// electrónica y lo dice. Sin datos del cliente. El acceso lo decide loadSaleReceipt (404 igual
// para todo lo que no le toca a quien mira). Se imprime con el diálogo del navegador.

export default async function SaleReceiptPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const result = await loadSaleReceipt({ publicId });
  if (!result.ok) {
    return (
      <main className="mx-auto flex w-full max-w-[380px] flex-col gap-6 px-4 pb-28 pt-6">
        <PageHeader title="Recibo" />
        <FormError message={result.error} />
      </main>
    );
  }
  const r = result.data;

  return (
    <main className="mx-auto flex w-full max-w-[380px] flex-col gap-4 px-4 pb-28 pt-6 md:py-10 print:max-w-none print:gap-0 print:p-0">
      <ReceiptToolbar title={`Recibo ${r.numberLabel} de ${r.location.name}`} />

      <article
        aria-labelledby="recibo-titulo"
        className="relative overflow-hidden rounded-xl border border-tinta/10 bg-papel shadow-sm print:overflow-visible print:rounded-none print:border-0 print:bg-white print:shadow-none"
      >
        {/* Borde perforado de tirilla: solo decoración. */}
        <div aria-hidden className="h-2 bg-[radial-gradient(circle,var(--color-laton)_2px,transparent_2.5px)] bg-[length:10px_8px] bg-center print:hidden" />

        <div className="flex flex-col gap-4 px-5 py-6 text-sm print:gap-2 print:px-0 print:py-0 print:text-[11px]">
          <header className="flex flex-col items-center gap-0.5 border-b border-dashed border-tinta/30 pb-3 text-center print:pb-2">
            <p className="font-display text-2xl leading-tight print:text-base">{r.location.name}</p>
            {r.location.taxId ? <p className="monto">NIT/C.C. {r.location.taxId}</p> : null}
            {r.location.address ? <p>{r.location.address}</p> : null}
            {r.location.phoneLabel ? <p className="monto">Tel. {r.location.phoneLabel}</p> : null}
          </header>

          <div className="flex flex-col gap-0.5">
            <h1 id="recibo-titulo" className="font-semibold">
              Recibo N.º <span className="monto">{r.numberLabel}</span>
            </h1>
            <p className="monto">
              {dayLabel(r.businessDate)} · {r.timeLabel}
            </p>
            {r.chargedByName ? <p>Cobró: {r.chargedByName}</p> : null}
          </div>

          {r.voided ? (
            <p role="note" className="self-center -rotate-3 rounded-md border-4 border-double border-alerta px-4 py-1 font-display text-2xl tracking-[0.2em] text-alerta">
              ANULADA
            </p>
          ) : null}

          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Servicios y productos</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Concepto y quién lo hizo o vendió</th>
                <th scope="col">Valor</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l, i) => (
                <tr key={i} className="border-b border-tinta/10 align-top">
                  <td className="py-1 pr-2">
                    {l.description}
                    <span className="block text-xs text-tinta/70 print:text-[10px]">{l.staffName}</span>
                    {l.discountLabel || l.hasQuantity ? (
                      <span className="monto block text-xs text-tinta/70 print:text-[10px]">
                        {l.unitPriceLabel}
                        {l.discountLabel ? ` · descuento ${l.discountLabel}` : null}
                      </span>
                    ) : null}
                  </td>
                  <td className="monto whitespace-nowrap py-1 text-right">{l.netLabel}</td>
                </tr>
              ))}
              {r.tips.map((t, i) => (
                <tr key={`p${i}`} className="border-b border-tinta/10 align-top">
                  <td className="py-1 pr-2">Propina · {t.staffName}</td>
                  <td className="monto whitespace-nowrap py-1 text-right">{t.amountLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="flex flex-col gap-0.5 border-t border-dashed border-tinta/30 pt-2">
            {r.discountLabel ? (
              <>
                <Row label="Subtotal" value={r.subtotalLabel} />
                <Row label="Descuentos" value={r.discountLabel} />
              </>
            ) : null}
            <div className="flex items-baseline justify-between gap-3 py-0.5">
              <dt className="font-semibold">TOTAL</dt>
              <dd className="monto text-xl font-semibold print:text-sm">{r.totalLabel}</dd>
            </div>
            {r.payments.map((p, i) => (
              <Row key={i} label={p.label} value={p.tenderedLabel ?? p.amountLabel} />
            ))}
            {r.changeLabel ? <Row label="Cambio" value={r.changeLabel} /> : null}
          </dl>

          <footer className="flex flex-col items-center gap-1 border-t border-dashed border-tinta/30 pt-3 text-center print:pt-2">
            {r.location.footer ? <p className="font-semibold">{r.location.footer}</p> : null}
            <p className="text-xs text-tinta/70 print:text-[10px]">Documento no válido como factura.</p>
          </footer>
        </div>

        <div aria-hidden className="h-2 bg-[radial-gradient(circle,var(--color-laton)_2px,transparent_2.5px)] bg-[length:10px_8px] bg-center print:hidden" />
      </article>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt>{label}</dt>
      <dd className="monto whitespace-nowrap">{value}</dd>
    </div>
  );
}
