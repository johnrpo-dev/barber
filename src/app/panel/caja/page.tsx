import { History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@/domain/staff/roles";
import { requirePermission } from "@/lib/session";
import { FormError } from "../_manage/controls";
import { PageHeader } from "../_components/ui";
import { loadCashView } from "./actions";
import { CashBoard } from "./cash-board";

export const metadata: Metadata = { title: "Caja · Villa" };

// Caja del día: turno, movimientos, cierre y ventas (recepción y dueño). El servidor vuelve a
// verificar cada permiso en cada acción; aquí solo se decide si se muestra la pantalla.
export default async function CajaPage() {
  const staff = await requirePermission("ledger.post");
  const view = await loadCashView();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      {can(staff.role, "cash.review") ? (
        // Aperturas y cierres de otros días: solo quien revisa la caja (ve el esperado).
        <Link
          href="/panel/caja/historial"
          className="-mb-3 inline-flex h-11 items-center gap-1.5 self-end rounded-lg border border-tinta/20 bg-papel px-3 text-sm font-semibold outline-none hover:border-tinta/40 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cuero"
        >
          <History size={18} aria-hidden /> Historial de caja
        </Link>
      ) : null}
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
