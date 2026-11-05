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

  // El orden es el de la barra; en el celular, si no cabe, lo marcado `more` y lo último van a "Más".
  const items: NavItem[] = [];
  const role = staff.role;
  if (can(role, "reports.financial")) items.push({ href: "/panel/inicio", label: "Inicio", icon: "inicio" });
  if (role === "barber") items.push({ href: "/panel/mi-dia", label: "Mi día", icon: "mi-dia" });
  if (can(role, "appointments.manage.all") || can(role, "appointments.manage.own")) {
    items.push({ href: "/panel/agenda", label: "Agenda", icon: "agenda" });
  }
  // Cobro y caja (sprint 4): recepción y dueño. En Anulaciones el dueño ve la cola; recepción, las suyas.
  if (can(role, "ledger.post")) {
    items.push({ href: "/panel/caja", label: "Caja", icon: "caja" });
    // Ventas del día y recibos para reimprimir: en el celular del dueño va a "Más".
    items.push({ href: "/panel/ventas", label: "Ventas", icon: "ventas", more: can(role, "reports.financial") });
    // El dueño llega a las anulaciones pendientes desde las alertas de Inicio: en el celular van a "Más".
    items.push({ href: "/panel/anulaciones", label: "Anulaciones", icon: "anulaciones", short: "Anular", more: can(role, "reports.financial") });
  }
  // Comisiones (sprint 5): el dueño ve las de todos; el barbero, solo las suyas.
  if (can(role, "commissions.view.all")) {
    items.push({ href: "/panel/comisiones", label: "Comisiones", icon: "comisiones" });
  } else if (can(role, "commissions.view.own")) {
    items.push({ href: "/panel/mis-comisiones", label: "Mis comisiones", icon: "mis-comisiones", short: "Comisiones" });
  }
  if (can(role, "reports.financial")) items.push({ href: "/panel/informes", label: "Informes", icon: "informes", more: true });
  if (can(role, "time_off.manage.all") || can(role, "time_off.manage.own")) {
    items.push({ href: "/panel/bloqueos", label: "Bloqueos", icon: "bloqueos" });
  }
  if (can(role, "services.manage")) items.push({ href: "/panel/servicios", label: "Servicios", icon: "servicios", more: true });
  if (can(role, "staff.manage")) items.push({ href: "/panel/personal", label: "Personal", icon: "personal", more: true });
  if (can(role, "settings.manage")) items.push({ href: "/panel/ajustes", label: "Ajustes", icon: "ajustes", more: true });
  if (can(role, "audit.view")) items.push({ href: "/panel/auditoria", label: "Auditoría", icon: "auditoria", more: true });
  if (can(role, "clients.erase")) items.push({ href: "/panel/clientes", label: "Clientes", icon: "clientes", more: true });

  return (
    <ToastProvider>
      <PanelNav items={items} userName={staff.displayName} roleLabel={ROLE_LABELS[staff.role]} signOut={signOut} />
      <div className="min-h-dvh pb-20 lg:pb-0 lg:pl-[72px] xl:pl-[232px] print:min-h-0 print:p-0">
        <MobileTopBar locationName={location?.name ?? ""} signOut={signOut} />
        {children}
      </div>
      <Suspense>
        <NoPermissionNotice />
      </Suspense>
    </ToastProvider>
  );
}
