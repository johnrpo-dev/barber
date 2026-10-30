import type { Metadata } from "next";
import { requirePermission } from "@/lib/session";
import { FormError } from "../_manage/controls";
import { PageHeader } from "../_components/ui";
import { loadCashView } from "./actions";
import { CashBoard } from "./cash-board";

export const metadata: Metadata = { title: "Caja · Villa" };

// Caja del día: turno, movimientos, cierre y ventas (recepción y dueño). El servidor vuelve a
// verificar cada permiso en cada acción; aquí solo se decide si se muestra la pantalla.
export default async function CajaPage() {
  await requirePermission("ledger.post");
  const view = await loadCashView();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      {view.ok ? (
        <CashBoard initial={view.data} />
      ) : (
        <>
          <PageHeader title="Caja" />
          <FormError message={view.error} />
        </>
      )}
    </main>
  );
}
