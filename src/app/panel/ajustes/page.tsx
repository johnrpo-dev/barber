import type { Metadata } from "next";
import { db } from "@/db/client";
import { locationSettings } from "@/db/locations";
import { listStaff } from "@/db/staff";
import type { Db } from "@/db/types";
import { formatPhone } from "@/domain/clients/client";
import { CHART_OF_ACCOUNTS } from "@/domain/ledger/accounts";
import { isExpenseCategoryAccount } from "@/domain/sales/cash";
import { requirePermission } from "@/lib/session";
import { FormError } from "../_manage/controls";
import { loadCheckoutSettings } from "./actions";
import { type AccountOption, CheckoutSettings } from "./checkout-settings";
import { type BookableRow, SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Ajustes · Villa" };

// Ajustes de la sede: reserva en línea, reglas de la agenda, quién atiende en línea y, desde el
// sprint 4, reglas de cobro, medios de pago y categorías de gasto.
export default async function AjustesPage() {
  const staff = await requirePermission("settings.manage");
  const conn = db() as unknown as Db;
  const [settings, members, checkout] = await Promise.all([
    locationSettings(conn, staff.locationId),
    listStaff(conn, staff.locationId),
    loadCheckoutSettings(),
  ]);
  // Cuentas a las que puede apuntar una categoría de gasto: la misma regla del dominio que valida el servidor.
  const accounts: AccountOption[] = CHART_OF_ACCOUNTS.filter((a) => isExpenseCategoryAccount(a.code)).map((a) => ({ code: a.code, name: a.name }));

  const bookable: BookableRow[] = members
    .filter((m) => m.active)
    .map((m) => ({ id: m.staffId.toString(), name: m.displayName, bookable: m.bookableOnline }));

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <SettingsForm
        settings={{ ...settings, publicPhone: settings.publicPhone ? formatPhone(settings.publicPhone) : "" }}
        staff={bookable}
      />
      {checkout.ok ? (
        <CheckoutSettings methods={checkout.data.methods} categories={checkout.data.categories} rules={checkout.data.rules} accounts={accounts} />
      ) : (
        <FormError message={`No se pudieron cargar los ajustes de cobro: ${checkout.error}`} />
      )}
    </main>
  );
}
