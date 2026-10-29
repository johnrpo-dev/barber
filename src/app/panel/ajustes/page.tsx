import type { Metadata } from "next";
import { db } from "@/db/client";
import { locationSettings } from "@/db/locations";
import { listStaff } from "@/db/staff";
import type { Db } from "@/db/types";
import { formatPhone } from "@/domain/clients/client";
import { requirePermission } from "@/lib/session";
import { type BookableRow, SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Ajustes · Villa" };

// Ajustes de la sede: reserva en línea, reglas de la agenda y quién atiende en línea.
export default async function AjustesPage() {
  const staff = await requirePermission("settings.manage");
  const conn = db() as unknown as Db;
  const [settings, members] = await Promise.all([locationSettings(conn, staff.locationId), listStaff(conn, staff.locationId)]);

  const bookable: BookableRow[] = members
    .filter((m) => m.active)
    .map((m) => ({ id: m.staffId.toString(), name: m.displayName, bookable: m.bookableOnline }));

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <SettingsForm
        settings={{ ...settings, publicPhone: settings.publicPhone ? formatPhone(settings.publicPhone) : "" }}
        staff={bookable}
      />
    </main>
  );
}
