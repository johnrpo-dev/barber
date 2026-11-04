import type { Metadata } from "next";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "../_components/ui";
import { FormError } from "../_manage/controls";
import { loadCommissionsOverview } from "./actions";
import { CommissionsBoard } from "./commissions-board";

export const metadata: Metadata = { title: "Comisiones · Villa" };

// Comisiones de todo el personal (docs/sprint-5-comisiones-informes.md §10): lo que se le debe a
// cada persona y su última liquidación. El servidor vuelve a verificar cada permiso en cada acción.
export default async function ComisionesPage() {
  await requirePermission("commissions.view.all");
  const view = await loadCommissionsOverview();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      {view.ok ? (
        <CommissionsBoard view={view.data} />
      ) : (
        <>
          <PageHeader title="Comisiones" />
          <FormError message={view.error} />
        </>
      )}
    </main>
  );
}
