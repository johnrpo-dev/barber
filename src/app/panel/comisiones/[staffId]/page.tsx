import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/domain/staff/roles";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "../../_components/ui";
import { FormError } from "../../_manage/controls";
import { loadStaffCommissions } from "../actions";
import { StaffCommissions } from "./staff-commissions";

export const metadata: Metadata = { title: "Comisiones · Villa" };

// Comisiones de una persona (docs/sprint-5-comisiones-informes.md §10): vista previa del servidor,
// formulario de liquidación, anticipos e historial. La sede sale de la sesión; el id, de la URL,
// y el servidor verifica que la persona sea de la sede.
export default async function StaffCommissionsPage({ params }: { params: Promise<{ staffId: string }> }) {
  const staff = await requirePermission("commissions.view.all");
  const staffId = (await params).staffId;
  if (!/^\d{1,18}$/.test(staffId)) notFound();
  const view = await loadStaffCommissions({ staffId });
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      {view.ok ? (
        <StaffCommissions initial={view.data} canSettle={can(staff.role, "commissions.settle")} />
      ) : (
        <>
          <Link href="/panel/comisiones" className="text-sm font-semibold text-cuero underline-offset-4 hover:underline">
            ← Comisiones
          </Link>
          <PageHeader title="Comisiones" />
          <FormError message={view.error} />
        </>
      )}
    </main>
  );
}
