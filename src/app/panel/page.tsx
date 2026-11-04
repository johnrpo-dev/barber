import { redirect } from "next/navigation";
import { can } from "@/domain/staff/roles";
import { requireStaff } from "@/lib/session";

// Entrada del panel: cada rol aterriza donde trabaja. El dueño (reports.financial) en su tablero,
// recepción en la Agenda y el barbero en Mi día (docs/sprint-5-comisiones-informes.md §7).
// El aviso de "sin permiso" viaja con la redirección para que el destino lo muestre.
export default async function PanelPage({ searchParams }: { searchParams: Promise<{ "sin-permiso"?: string | string[] }> }) {
  const staff = await requireStaff();
  const home = can(staff.role, "reports.financial") ? "/panel/inicio" : staff.role === "barber" ? "/panel/mi-dia" : "/panel/agenda";
  const denied = (await searchParams)["sin-permiso"] === "1";
  redirect(denied ? `${home}?sin-permiso=1` : home);
}
