import type { Metadata } from "next";
import { db } from "@/db/client";
import { listServices } from "@/db/catalog";
import type { Db } from "@/db/types";
import { format } from "@/domain/money";
import { requirePermission } from "@/lib/session";
import { type ServiceRow, ServicesManager } from "./services-manager";

export const metadata: Metadata = { title: "Servicios · Villa" };

export default async function ServiciosPage() {
  const staff = await requirePermission("services.manage");
  const services = await listServices(db() as unknown as Db, { locationId: staff.locationId, includeInactive: true });

  // bigint no viaja como JSON: ids y montos van como texto (centavos); el precio ya formateado
  // desde el servidor evita diferencias de Intl entre servidor y navegador al hidratar.
  const rows: ServiceRow[] = services.map((s) => ({
    id: s.id.toString(),
    name: s.name,
    durationMin: s.durationMin,
    bufferMin: s.bufferMin,
    priceMinor: s.price.minor.toString(),
    priceLabel: format(s.price),
    commissionBps: s.commissionBps,
    active: s.active,
  }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <ServicesManager services={rows} />
    </main>
  );
}
