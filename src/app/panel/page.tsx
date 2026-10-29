import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/session";

// Entrada del panel: cada rol aterriza donde trabaja. El tablero del dueño llega en el sprint 5.
// El aviso de "sin permiso" viaja con la redirección para que el destino lo muestre.
export default async function PanelPage({ searchParams }: { searchParams: Promise<{ "sin-permiso"?: string | string[] }> }) {
  const staff = await requireStaff();
  const home = staff.role === "barber" ? "/panel/mi-dia" : "/panel/agenda";
  const denied = (await searchParams)["sin-permiso"] === "1";
  redirect(denied ? `${home}?sin-permiso=1` : home);
}
