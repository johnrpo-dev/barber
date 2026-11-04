import type { Metadata } from "next";
import { requirePermission } from "@/lib/session";
import { ClientErase } from "./client-erase";

export const metadata: Metadata = { title: "Clientes · Villa" };

export default async function ClientesPage() {
  await requirePermission("clients.erase");
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-28 pt-6 md:px-8 md:py-10">
      <ClientErase />
    </main>
  );
}
