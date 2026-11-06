import type { Metadata } from "next";
import { can } from "@/domain/staff/roles";
import { requirePermission } from "@/lib/session";
import { ClientRecordScreen } from "./client-record";

export const metadata: Metadata = { title: "Clientes · Villa" };

// Ficha del cliente (clients.manage: dueño y recepción). La supresión de datos (clients.erase: solo
// el dueño) se abre desde la misma ficha. Cada acción vuelve a exigir su permiso en el servidor.
export default async function ClientesPage() {
  const staff = await requirePermission("clients.manage");
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      <ClientRecordScreen canErase={can(staff.role, "clients.erase")} />
    </main>
  );
}
