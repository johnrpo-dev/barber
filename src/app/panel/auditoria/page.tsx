import type { Metadata } from "next";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "../_components/ui";
import { FormError } from "../_manage/controls";
import { loadAuditLog } from "./actions";
import { AuditLog } from "./audit-log";

export const metadata: Metadata = { title: "Auditoría · Villa" };

// Bitácora de auditoría (docs/sprint-5-comisiones-informes.md §8): solo el dueño (audit.view).
// Lista de 50 en 50, de la más reciente a la más antigua, con filtros por fechas y categoría.
export default async function AuditoriaPage() {
  await requirePermission("audit.view");
  const log = await loadAuditLog({});
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      {log.ok ? (
        <AuditLog initial={log.data} />
      ) : (
        <>
          <PageHeader title="Auditoría" />
          <FormError message={log.error} />
        </>
      )}
    </main>
  );
}
