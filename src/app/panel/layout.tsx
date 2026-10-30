import { eq } from "drizzle-orm";
import { Suspense } from "react";
import { db } from "@/db/client";
import { locations } from "@/db/schema";
import { can, ROLE_LABELS } from "@/domain/staff/roles";
import { requireStaff } from "@/lib/session";
import { signOut } from "./actions";
import { NoPermissionNotice } from "./_components/no-permission-notice";
import { MobileTopBar, type NavItem, PanelNav } from "./_components/panel-nav";
import { ToastProvider } from "./_components/ui";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaff();
  const [location] = await db().select({ name: locations.name }).from(locations).where(eq(locations.id, staff.locationId));

  const items: NavItem[] = [];
  if (staff.role === "barber") items.push({ href: "/panel/mi-dia", label: "Mi día", icon: "mi-dia" });
  if (can(staff.role, "appointments.manage.all") || can(staff.role, "appointments.manage.own")) {
    items.push({ href: "/panel/agenda", label: "Agenda", icon: "agenda" });
  }
  // Cobro y caja (sprint 4): recepción y dueño. En Anulaciones el dueño ve la cola; recepción, las suyas.
  if (can(staff.role, "ledger.post")) {
    items.push({ href: "/panel/caja", label: "Caja", icon: "caja" });
    items.push({ href: "/panel/anulaciones", label: "Anulaciones", icon: "anulaciones", short: "Anular" });
  }
  if (can(staff.role, "time_off.manage.all") || can(staff.role, "time_off.manage.own")) {
    items.push({ href: "/panel/bloqueos", label: "Bloqueos", icon: "bloqueos" });
  }
  if (can(staff.role, "services.manage")) items.push({ href: "/panel/servicios", label: "Servicios", icon: "servicios" });
  if (can(staff.role, "staff.manage")) items.push({ href: "/panel/personal", label: "Personal", icon: "personal" });
  if (can(staff.role, "settings.manage")) items.push({ href: "/panel/ajustes", label: "Ajustes", icon: "ajustes" });

  return (
    <ToastProvider>
      <PanelNav items={items} userName={staff.displayName} roleLabel={ROLE_LABELS[staff.role]} signOut={signOut} />
      <div className="min-h-dvh pb-20 lg:pb-0 lg:pl-[72px] xl:pl-[232px]">
        <MobileTopBar locationName={location?.name ?? ""} signOut={signOut} />
        {children}
      </div>
      <Suspense>
        <NoPermissionNotice />
      </Suspense>
    </ToastProvider>
  );
}
