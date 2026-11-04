import type { Metadata } from "next";
import Link from "next/link";
import { today } from "@/db/cash";
import { db } from "@/db/client";
import type { Db } from "@/db/types";
import { presetPeriod } from "@/domain/reports/period";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "../_components/ui";
import { FormError } from "../_manage/controls";
import { loadReport } from "./actions";
import { ReportsView } from "./reports-view";

export const metadata: Metadata = { title: "Informes · Villa" };

// Informes del dueño (docs/sprint-5-comisiones-informes.md §6 y §10). Abre en "este mes" según el
// día contable de la sede (nunca el del navegador), o en el periodo de la URL (?desde=&hasta=).
// Todo se suma en SQL; la interfaz solo muestra las etiquetas y arma el CSV que manda el servidor.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default async function InformesPage({ searchParams }: { searchParams: Promise<{ desde?: string | string[]; hasta?: string | string[] }> }) {
  const staff = await requirePermission("reports.financial");
  const sp = await searchParams;
  const desde = typeof sp.desde === "string" && DAY.test(sp.desde) ? sp.desde : null;
  const hasta = typeof sp.hasta === "string" && DAY.test(sp.hasta) ? sp.hasta : null;
  let period: { from: string; to: string };
  if (desde && hasta) {
    period = { from: desde, to: hasta };
  } else {
    const day = await today(db() as unknown as Db, staff.locationId);
    period = presetPeriod("this_month", day.businessDate);
  }
  const view = await loadReport(period);
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-44 pt-6 md:px-8 md:pt-10 lg:pb-28">
      {view.ok ? (
        <ReportsView initial={view.data} />
      ) : (
        <>
          <PageHeader title="Informes" />
          <FormError message={view.error} />
          {desde && hasta ? (
            <Link href="/panel/informes" className="self-start text-sm font-semibold text-cuero underline underline-offset-4">
              Ver el informe de este mes
            </Link>
          ) : null}
        </>
      )}
    </main>
  );
}
