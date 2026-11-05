import { ChevronLeft, ChevronRight, Printer } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { addDays } from "@/domain/booking/clock";
import { dayLong, plural } from "../_components/dates";
import { cx, PageHeader } from "../_components/ui";
import { card, FormError } from "../_manage/controls";
import { loadSalesOfDay } from "./actions";

export const metadata: Metadata = { title: "Ventas · Villa" };

// Ventas de un día para reimprimir su recibo. Recepción ve solo hoy; el dueño navega por días.
// Sin datos del cliente. Los totales del día están en Caja e Informes (calculados en SQL).

const navLink =
  "inline-flex h-11 items-center gap-1 rounded-lg border border-tinta/20 bg-papel px-3 text-sm font-semibold outline-none hover:border-tinta/40 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cuero";

export default async function VentasPage({ searchParams }: { searchParams: Promise<{ dia?: string | string[] }> }) {
  const dia = (await searchParams).dia;
  const result = await loadSalesOfDay({ date: typeof dia === "string" ? dia : undefined });
  if (!result.ok) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
        <PageHeader title="Ventas" />
        <FormError message={result.error} />
      </main>
    );
  }
  const v = result.data;
  const isToday = v.businessDate === v.today;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      <PageHeader eyebrow={isToday ? "Hoy" : undefined} title="Ventas" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-semibold">
          {dayLong(v.businessDate)} · <span className="monto">{plural(v.paidCount, "venta", "ventas")}</span>
        </p>
        {v.canPickDay ? (
          <nav aria-label="Cambiar de día" className="flex gap-2">
            <Link href={`/panel/ventas?dia=${addDays(v.businessDate, -1)}`} className={navLink}>
              <ChevronLeft size={18} aria-hidden /> Anterior
            </Link>
            {!isToday ? (
              <>
                <Link href={`/panel/ventas?dia=${addDays(v.businessDate, 1)}`} className={navLink}>
                  Siguiente <ChevronRight size={18} aria-hidden />
                </Link>
                <Link href="/panel/ventas" className={navLink}>
                  Hoy
                </Link>
              </>
            ) : null}
          </nav>
        ) : null}
      </div>

      {v.sales.length === 0 ? (
        <p className={cx(card, "p-5 text-tinta/70")}>No hay ventas este día.</p>
      ) : (
        <ul className={cx(card, "divide-y divide-tinta/10")}>
          {v.sales.map((s) => (
            <li key={s.publicId}>
              <Link
                href={`/panel/ventas/${s.publicId}`}
                className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-tinta/5 focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-cuero"
              >
                <span className="monto w-12 shrink-0 text-sm text-tinta/70">{s.timeLabel}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{s.services || "Venta"}</span>
                  <span className="truncate text-xs text-tinta/70">
                    {s.staff} · N.º <span className="monto">{s.numberLabel}</span>
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className={cx("monto font-semibold", s.voided && "text-tinta/50 line-through")}>{s.totalLabel}</span>
                  {s.voided ? <span className="text-xs font-semibold text-alerta">Anulada</span> : null}
                </span>
                <Printer size={18} className="shrink-0 text-tinta/50" aria-label="Ver e imprimir el recibo" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
