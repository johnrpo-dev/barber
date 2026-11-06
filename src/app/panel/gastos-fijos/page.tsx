import type { Metadata } from "next";
import { requirePermission } from "@/lib/session";
import { FormError } from "../_manage/controls";
import { PageHeader } from "../_components/ui";
import { loadRecurringExpenses } from "./actions";
import { RecurringBoard } from "./recurring-board";

export const metadata: Metadata = { title: "Gastos fijos · Villa" };

// Gastos fijos (sprint 8, docs/sprint-8-gastos-controles.md §5): plantillas y lo que toca pagar. Solo
// quien maneja los ajustes de la sede (el dueño). El servidor vuelve a verificar cada permiso en cada
// acción; recepción registra los de caja desde Caja.
export default async function GastosFijosPage() {
  await requirePermission("settings.manage");
  const view = await loadRecurringExpenses();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      {view.ok ? (
        <RecurringBoard initial={view.data} />
      ) : (
        <>
          <PageHeader title="Gastos fijos" />
          <FormError message={view.error} />
        </>
      )}
    </main>
  );
}
