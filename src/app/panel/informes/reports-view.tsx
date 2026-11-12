"use client";

import { BookOpen, CalendarRange, Download } from "lucide-react";
import Link from "next/link";
import { type FormEvent, type ReactNode, useCallback, useId, useState } from "react";
import { Form, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { daysBetween, MAX_REPORT_DAYS } from "@/domain/reports/period";
import { DateField } from "../_components/date-field";
import { dayLabel, dayShort, plural } from "../_components/dates";
import { callAction } from "../_components/money-field";
import { Btn, cx, PageHeader, useToast } from "../_components/ui";
import { card, FormError } from "../_manage/controls";
import { exportReportCsvAction, loadReport } from "./actions";

// Informes por rango de días contables (docs/sprint-5-comisiones-informes.md §6). Todo llega
// sumado y formateado del servidor. En el celular cada sección es una lista; desde md, una tabla.
// El CSV lo arma el servidor ({ filename, csv } con BOM); aquí solo se guarda con un Blob.

type OkData<R> = R extends { ok: true; data: infer D } ? D : never;
type Report = OkData<Awaited<ReturnType<typeof loadReport>>>;
type CsvReport = Parameters<typeof exportReportCsvAction>[0]["report"];

const CUSTOM = "custom";

export function ReportsView({ initial }: { initial: Report }) {
  const toast = useToast();
  const [report, setReport] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState(() => !initial.presets.some((p) => p.from === initial.period.from && p.to === initial.period.to));
  const [from, setFrom] = useState(initial.period.from);
  const [to, setTo] = useState(initial.period.to);
  const [exporting, setExporting] = useState<CsvReport | null>(null);

  const selected = custom ? CUSTOM : (report.presets.find((p) => p.from === report.period.from && p.to === report.period.to)?.key ?? CUSTOM);

  const load = useCallback(async (period: { from: string; to: string }) => {
    setError(null);
    setLoading(true);
    const r = await callAction(() => loadReport(period));
    setLoading(false);
    if (!r.ok) return setError(r.error);
    setReport(r.data);
    setFrom(r.data.period.from);
    setTo(r.data.period.to);
    // La URL guarda el periodo para volver o compartirlo, sin recargar.
    const url = new URL(window.location.href);
    url.searchParams.set("desde", r.data.period.from);
    url.searchParams.set("hasta", r.data.period.to);
    window.history.replaceState(null, "", url);
  }, []);

  function applyCustom(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!from || !to) return setError("Elige las dos fechas del periodo.");
    if (from > to) return setError("La fecha inicial no puede ser posterior a la final.");
    if (daysBetween(from, to) + 1 > MAX_REPORT_DAYS) return setError(`El periodo puede tener máximo ${MAX_REPORT_DAYS} días.`);
    void load({ from, to });
  }

  async function exportCsv(kind: CsvReport) {
    setExporting(kind);
    const r = await callAction(() => exportReportCsvAction({ report: kind, from: report.period.from, to: report.period.to }));
    setExporting(null);
    if (!r.ok) return toast(r.error, "error");
    const blob = new Blob([r.data.csv], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = r.data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    toast(`Descargado: ${r.data.filename}`);
  }

  const exportBtn = (kind: CsvReport, label = "Exportar CSV") => (
    <Btn variant="secondary" size="sm" className="h-11" onPress={() => void exportCsv(kind)} isPending={exporting === kind} isDisabled={exporting !== null && exporting !== kind}>
      <Download size={16} aria-hidden /> {exporting === kind ? "Preparando…" : label}
    </Btn>
  );

  const r = report;
  const soldProducts = r.byStaff.some((s) => s.productsNetMinor !== "0");
  const pnl = r.pnl;

  return (
    <>
      <PageHeader
        eyebrow="Informes del negocio"
        title="Informes"
        actions={
          <Btn variant="secondary" onPress={() => void exportCsv("journal")} isPending={exporting === "journal"} isDisabled={exporting !== null && exporting !== "journal"}>
            <BookOpen size={18} aria-hidden /> {exporting === "journal" ? "Preparando…" : "Libro diario"}
          </Btn>
        }
      />

      {/* Selector de periodo, fijo arriba */}
      <div className={cx("-mx-4 flex flex-col gap-3 border-b border-tinta/10 bg-hueso/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8", !custom && "sticky top-0 z-20")}>
        <ToggleButtonGroup
          aria-label="Periodo"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[selected]}
          isDisabled={loading}
          onSelectionChange={(keys) => {
            const k = [...keys][0];
            if (k === undefined) return;
            if (k === CUSTOM) return setCustom(true);
            const preset = r.presets.find((p) => p.key === k);
            if (!preset) return;
            setCustom(false);
            void load({ from: preset.from, to: preset.to });
          }}
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]"
        >
          {[...r.presets.map((p) => ({ id: p.key as string, label: p.label })), { id: CUSTOM, label: "Personalizado" }].map((p) => (
            <ToggleButton
              key={p.id}
              id={p.id}
              className={({ isSelected, isFocusVisible }) =>
                cx(
                  "h-10 shrink-0 whitespace-nowrap rounded-full border px-3.5 text-sm font-semibold transition-colors",
                  isSelected ? "border-cuero bg-cuero text-hueso" : "border-tinta/20 bg-papel text-tinta/80",
                  isFocusVisible && "outline-3 outline-offset-2 outline-cuero",
                )
              }
            >
              {p.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {custom ? (
          <Form onSubmit={applyCustom} validationBehavior="aria" className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <DateField label="Desde" value={from} onChange={setFrom} max={to || undefined} isRequired />
            <DateField label="Hasta" value={to} onChange={setTo} min={from || undefined} isRequired />
            <Btn type="submit" className="col-span-2 h-12 sm:col-span-1" isPending={loading}>
              <CalendarRange size={18} aria-hidden /> Ver
            </Btn>
          </Form>
        ) : null}

        <p className="text-sm text-tinta/80" aria-live="polite">
          {loading ? "Cargando el informe…" : <span className="monto font-semibold">{r.period.from === r.period.to ? dayLabel(r.period.from) : `${dayLabel(r.period.from)} al ${dayLabel(r.period.to)}`}</span>}
        </p>
        <FormError message={error} />
      </div>

      <div aria-busy={loading} className={cx("flex flex-col gap-8 transition-opacity", loading && "opacity-60")}>
        {/* Estado de resultados */}
        <Section id="pnl" title="Estado de resultados" action={exportBtn("pnl")}>
          <div className="grid gap-4 md:grid-cols-2">
            <AmountTable caption="Ingresos" rows={pnl.income} totalLabel="Total ingresos" total={pnl.totalIncomeLabel} />
            <AmountTable caption="Gastos" rows={pnl.expenses} totalLabel="Total gastos" total={pnl.totalExpensesLabel} />
          </div>
          <div className={cx(card, "flex items-center justify-between gap-3 px-4 py-3")}>
            <span className="font-semibold">Utilidad</span>
            <span className="flex flex-col items-end">
              <span className={cx("monto font-display text-2xl", pnl.profitMinor.startsWith("-") && "text-alerta")}>{pnl.profitLabel}</span>
              {pnl.marginLabel ? <span className="monto text-xs text-tinta/70">Margen {pnl.marginLabel}</span> : null}
            </span>
          </div>
          <p className="text-xs text-tinta/70">Las propinas no son ingreso del negocio: se le deben al personal. Una anulación resta el día en que se aprueba, no el de la venta.</p>
          {r.products ? (
            <div className={cx(card, "flex flex-col gap-2 px-4 py-3")}>
              <h3 className="font-semibold">Margen de productos</h3>
              <dl className="flex flex-col gap-1 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt>Ventas de productos</dt>
                  <dd className="monto">{r.products.incomeLabel}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt>Costo de ventas (del conteo)</dt>
                  <dd className="monto">{r.products.costLabel}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-t border-tinta/10 pt-1">
                  <dt className="font-semibold">Margen</dt>
                  <dd className="flex flex-col items-end">
                    <span className={cx("monto text-lg font-semibold", r.products.marginMinor.startsWith("-") && "text-alerta")}>{r.products.marginLabel}</span>
                    {r.products.rateLabel ? <span className="monto text-xs text-tinta/70">{r.products.rateLabel} de las ventas</span> : null}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-tinta/70">
                {r.products.counted
                  ? "El costo es lo que bajó el inventario entre conteos: lo vendido más lo que se perdió o se usó en el local. Es exacto para un mes cerrado con su conteo."
                  : "En este periodo no hubo conteo de inventario: el costo de lo vendido todavía no se conoce y el margen sale inflado. Mira el mes completo después del conteo del último día."}
              </p>
            </div>
          ) : null}
        </Section>

        {/* Ventas por barbero */}
        <Section id="by-staff" title="Ventas por barbero" action={exportBtn("by_staff")}>
          <DataTable
            caption="Ventas por barbero"
            cols={[
              { label: "Barbero" },
              { label: "Servicios", numeric: true },
              { label: "Bruto", numeric: true },
              { label: "Descuentos", numeric: true },
              { label: "Neto", numeric: true },
              // Productos (sprint 6): solo si alguien vendió en el periodo.
              ...(soldProducts ? [{ label: "Productos", numeric: true }] : []),
              { label: "Comisión", numeric: true },
              { label: "Propinas", numeric: true },
            ]}
            rows={r.byStaff.map((s) => ({
              key: s.staffId,
              cells: [
                s.name,
                String(s.services),
                s.grossLabel,
                s.discountLabel,
                s.netLabel,
                ...(soldProducts ? [s.productsNetLabel] : []),
                s.commissionLabel,
                s.tipsLabel,
              ],
            }))}
            empty="No hubo ventas en el periodo."
          />
        </Section>

        {/* Ventas por servicio */}
        <Section id="by-service" title="Ventas por servicio" action={exportBtn("by_service")}>
          <DataTable
            caption="Ventas por servicio"
            cols={[{ label: "Servicio" }, { label: "Cantidad", numeric: true }, { label: "Neto", numeric: true }, { label: "Participación", numeric: true }]}
            rows={r.byService.map((s) => ({ key: s.serviceId, cells: [s.name, String(s.services), s.netLabel, s.shareLabel ?? "—"] }))}
            empty="No hubo ventas en el periodo."
          />
        </Section>

        {/* Medios de pago */}
        <Section id="payments" title="Medios de pago" action={exportBtn("payments")}>
          <DataTable
            caption="Medios de pago"
            cols={[
              { label: "Medio" },
              { label: "Pagos", numeric: true },
              { label: "Monto", numeric: true },
              { label: "Datáfono", numeric: true },
              { label: "Participación", numeric: true },
            ]}
            rows={r.payments.map((p) => ({ key: `${p.kind}-${p.label}`, cells: [p.label, String(p.payments), p.amountLabel, p.feesLabel, p.shareLabel ?? "—"] }))}
            empty="No hubo pagos en el periodo."
          />
        </Section>

        {/* Propinas */}
        <Section id="tips" title="Propinas" action={exportBtn("tips")}>
          <DataTable
            caption="Propinas por persona"
            cols={[
              { label: "Barbero" },
              { label: "Recibidas", numeric: true },
              { label: "Parte del datáfono", numeric: true },
              { label: "Por pagar", numeric: true },
              { label: "Pagadas", numeric: true },
            ]}
            rows={r.tips.rows.map((t) => ({ key: t.staffId, cells: [t.name, t.tipsLabel, t.feeShareLabel, t.payableLabel, t.paidOutLabel] }))}
            foot={{ label: "Total recibidas", value: r.tips.totalLabel, col: 1 }}
            empty="No hubo propinas en el periodo."
          />
        </Section>

        {/* Datáfono */}
        <Section id="card-fees" title="Costo del datáfono">
          <DataTable
            caption="Costo del datáfono por medio"
            cols={[{ label: "Medio" }, { label: "Costo", numeric: true }]}
            rows={r.cardFees.byMethod.map((m) => ({ key: m.label, cells: [m.label, m.feesLabel] }))}
            foot={{ label: "Total en el libro", value: r.cardFees.totalLabel, col: 1 }}
            empty="Sin costos de datáfono en el periodo."
          />
        </Section>

        {/* Gastos */}
        <Section id="expenses" title="Gastos por categoría" action={exportBtn("expenses")}>
          <DataTable
            caption="Gastos por categoría"
            cols={[{ label: "Categoría" }, { label: "Origen" }, { label: "Cantidad", numeric: true }, { label: "Monto", numeric: true }]}
            rows={r.expenses.map((x, i) => ({ key: `${x.name}-${x.paidFrom}-${i}`, cells: [x.name, x.paidFrom === "cash" ? "Caja" : "Banco", String(x.count), x.amountLabel] }))}
            empty="No hubo gastos en el periodo."
          />
        </Section>

        {/* Diferencias de caja */}
        <Section id="cash-differences" title="Diferencias de caja" action={exportBtn("cash_differences")}>
          <DataTable
            caption="Diferencias de caja"
            cols={[{ label: "Fecha" }, { label: "Momento" }, { label: "Diferencia", numeric: true }, { label: "Nota" }, { label: "Contó" }]}
            rows={r.cashDifferences.items.map((c, i) => ({
              key: `${c.businessDate}-${c.moment}-${i}`,
              cells: [
                dayShort(c.businessDate),
                c.moment === "opening" ? "Apertura" : "Cierre",
                <span key="d" className={c.sign === "-" ? "text-alerta" : "text-botella"}>
                  <span className="sr-only">{c.sign === "-" ? "Faltante " : "Sobrante "}</span>
                  {c.sign === "-" ? "−" : "+"}{c.differenceLabel}
                </span>,
                c.note ?? "—",
                c.by,
              ],
            }))}
            foot={{ label: "Neto del periodo", value: r.cashDifferences.netLabel, col: 2 }}
            empty="Sin diferencias de caja en el periodo."
          />
        </Section>

        {/* Inasistencias */}
        <Section id="no-show" title="Inasistencias">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Reservas" value={String(r.noShow.reservations)} />
            <Stat label="Atendidas" value={String(r.noShow.completed)} />
            <Stat label="No vinieron" value={String(r.noShow.noShow)} />
            <Stat label="Canceladas" value={`${r.noShow.cancelled}${r.noShow.lateCancelled > 0 ? ` (${r.noShow.lateCancelled} tarde)` : ""}`} />
            <Stat label="Tasa de inasistencia" value={r.noShow.rateLabel ?? "—"} />
          </dl>
          {r.noShow.byStaff.length > 0 ? (
            <DataTable
              caption="Inasistencias por barbero"
              cols={[{ label: "Barbero" }, { label: "Atendidas", numeric: true }, { label: "No vinieron", numeric: true }, { label: "Tasa", numeric: true }]}
              rows={r.noShow.byStaff.map((s, i) => ({ key: `${s.name}-${i}`, cells: [s.name, String(s.completed), String(s.noShow), s.rateLabel ?? "—"] }))}
              empty=""
            />
          ) : null}
          <p className="text-xs text-tinta/70">Solo citas reservadas (sin las de llegada directa). Tasa = no vinieron / (atendidas + no vinieron).</p>
        </Section>

        {/* Liquidaciones */}
        <Section id="settlements" title="Liquidaciones" action={exportBtn("settlements")}>
          <DataTable
            caption="Liquidaciones del periodo"
            cols={[{ label: "Número" }, { label: "Barbero" }, { label: "Corte" }, { label: "Pagada" }, { label: "Pago", numeric: true }, { label: "Estado" }]}
            rows={r.settlements.map((s) => ({
              key: s.publicId,
              cells: [
                <Link key="n" href={`/panel/comprobantes/${s.publicId}`} className="font-semibold text-cuero underline-offset-2 hover:underline">
                  {s.numberLabel}
                </Link>,
                s.staffName,
                dayShort(s.cutoffDate),
                dayShort(s.businessDate),
                <span key="p" className={s.status === "reversed" ? "text-tinta/60 line-through" : undefined}>
                  {s.payoutLabel}
                </span>,
                s.status === "reversed" ? "Revertida" : "Vigente",
              ],
            }))}
            empty="No hubo liquidaciones en el periodo."
          />
        </Section>

        {/* Cortesías */}
        <Section id="courtesies" title="Cortesías" action={exportBtn("courtesies")}>
          <DataTable
            caption="Cortesías por barbero"
            cols={[{ label: "Barbero" }, { label: "Cortesías", numeric: true }, { label: "Precio de lista", numeric: true }]}
            rows={r.courtesies.rows.map((c) => ({ key: c.staffId, cells: [c.name, String(c.courtesies), c.listPriceLabel] }))}
            foot={{ label: `Total (${plural(r.courtesies.total, "cortesía", "cortesías")})`, value: r.courtesies.totalListPriceLabel, col: 2 }}
            empty="No hubo cortesías en el periodo."
          />
          <p className="text-xs text-tinta/70">Citas atendidas que no se cobraron: no son ingreso ni generan comisión. El precio de lista es lo que se habría cobrado.</p>
        </Section>
      </div>

      {/* Totales fijos abajo */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t border-tinta/10 bg-papel/95 backdrop-blur lg:bottom-0 lg:left-[72px] xl:left-[232px]">
        <dl className="mx-auto grid max-w-5xl grid-cols-3 gap-2 px-4 py-2 text-center md:px-8">
          <div className="flex min-w-0 flex-col">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-tinta/70">Ingresos</dt>
            <dd className="monto truncate text-sm font-semibold sm:text-base">{pnl.totalIncomeLabel}</dd>
          </div>
          <div className="flex min-w-0 flex-col">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-tinta/70">Gastos</dt>
            <dd className="monto truncate text-sm font-semibold sm:text-base">{pnl.totalExpensesLabel}</dd>
          </div>
          <div className="flex min-w-0 flex-col">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-tinta/70">Utilidad</dt>
            <dd className={cx("monto truncate text-sm font-semibold sm:text-base", pnl.profitMinor.startsWith("-") && "text-alerta")}>{pnl.profitLabel}</dd>
          </div>
        </dl>
      </div>
    </>
  );
}

function Section({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`sec-${id}`} className="flex scroll-mt-40 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id={`sec-${id}`} className="font-display text-2xl leading-tight">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={cx(card, "flex flex-col gap-0.5 px-3 py-2.5")}>
      <dt className="text-xs text-tinta/70">{label}</dt>
      <dd className="monto text-lg font-semibold">{value}</dd>
    </div>
  );
}

function AmountTable({ caption, rows, totalLabel, total }: { caption: string; rows: Report["pnl"]["income"]; totalLabel: string; total: string }) {
  const captionId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* Fuera de la tabla: dentro del overflow-hidden de la tarjeta se recortaba la primera letra. */}
      <p id={captionId} className="text-xs font-semibold uppercase tracking-[0.16em] text-tinta/70">
        {caption}
      </p>
      <div className={cx(card, "overflow-hidden")}>
    <table aria-labelledby={captionId} className="w-full border-separate border-spacing-0 text-sm">
      <thead className="sr-only">
        <tr>
          <th scope="col">Cuenta</th>
          <th scope="col">Valor</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={2} className="px-4 py-3 text-tinta/70">
              Sin movimientos.
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr key={row.code}>
              <th scope="row" className="border-b border-tinta/10 px-4 py-2 text-left font-normal">
                <span className="monto mr-2 text-xs text-tinta/60">{row.code}</span>
                {row.name}
              </th>
              <td className={cx("monto whitespace-nowrap border-b border-tinta/10 py-2 pr-4 text-right", row.amountMinor.startsWith("-") && "text-alerta")}>{row.amountLabel}</td>
            </tr>
          ))
        )}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" className="px-4 py-2.5 text-left font-semibold">
            {totalLabel}
          </th>
          <td className="monto whitespace-nowrap py-2.5 pr-4 text-right font-semibold">{total}</td>
        </tr>
      </tfoot>
    </table>
      </div>
    </div>
  );
}

type Col = { label: string; numeric?: boolean };

/** Tabla en escritorio y lista de tarjetas en el celular, con los mismos datos. */
function DataTable({
  caption,
  cols,
  rows,
  foot,
  empty,
}: {
  caption: string;
  cols: Col[];
  rows: { key: string; cells: ReactNode[] }[];
  /** Fila de totales: el valor va en la columna `col`. */
  foot?: { label: string; value: string; col: number };
  empty: string;
}) {
  if (rows.length === 0) return empty ? <p className="text-sm text-tinta/70">{empty}</p> : null;
  return (
    <>
      {/* Celular: lista */}
      <div className="md:hidden">
        <p className="sr-only">{caption}</p>
        <ul className={cx(card, "divide-y divide-tinta/10")}>
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-1.5 px-4 py-3">
              <p className="font-semibold">{row.cells[0]}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                {cols.slice(1).map((c, i) => (
                  <div key={c.label} className="flex min-w-0 flex-col">
                    <dt className="text-xs text-tinta/70">{c.label}</dt>
                    <dd className={cx("min-w-0 break-words", c.numeric && "monto font-semibold")}>{row.cells[i + 1]}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
          {foot ? (
            <li className="flex items-center justify-between gap-3 bg-tinta/[0.03] px-4 py-3">
              <span className="font-semibold">{foot.label}</span>
              <span className="monto font-semibold">{foot.value}</span>
            </li>
          ) : null}
        </ul>
        <p className="mt-1 text-xs text-tinta/70">{plural(rows.length, "fila", "filas")}</p>
      </div>

      {/* Escritorio: tabla */}
      <div className={cx(card, "hidden overflow-x-auto md:block")}>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-tinta/15 text-xs text-tinta/70">
              {cols.map((c) => (
                <th key={c.label} scope="col" className={cx("px-4 py-2.5 font-semibold", c.numeric ? "text-right" : "text-left")}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-tinta/10 last:border-0">
                {row.cells.map((cell, i) =>
                  i === 0 ? (
                    <th key={i} scope="row" className="px-4 py-2.5 text-left font-semibold">
                      {cell}
                    </th>
                  ) : (
                    <td key={i} className={cx("px-4 py-2.5", cols[i]?.numeric ? "monto whitespace-nowrap text-right" : "text-left")}>
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
          {foot ? (
            <tfoot>
              <tr className="border-t-2 border-tinta/15">
                <th scope="row" colSpan={foot.col} className="px-4 py-2.5 text-left font-semibold">
                  {foot.label}
                </th>
                <td className="monto whitespace-nowrap px-4 py-2.5 text-right font-semibold">{foot.value}</td>
                {cols.slice(foot.col + 1).map((c) => (
                  <td key={c.label} />
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </>
  );
}
