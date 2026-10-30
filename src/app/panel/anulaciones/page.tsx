import type { Metadata } from "next";
import { can } from "@/domain/staff/roles";
import { requirePermission } from "@/lib/session";
import { FormError } from "../_manage/controls";
import { PageHeader } from "../_components/ui";
import { loadVoidQueue } from "./actions";
import { VoidQueue } from "./void-queue";

export const metadata: Metadata = { title: "Anulaciones · Villa" };

// El dueño (ledger.reverse) ve la cola y decide; recepción ve sus solicitudes. El servidor filtra.
export default async function AnulacionesPage() {
  const staff = await requirePermission("ledger.post");
  const queue = await loadVoidQueue();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      {queue.ok ? (
        <VoidQueue initial={queue.data} canDecide={can(staff.role, "ledger.reverse")} />
      ) : (
        <>
          <PageHeader title="Anulaciones" />
          <FormError message={queue.error} />
        </>
      )}
    </main>
  );
}
