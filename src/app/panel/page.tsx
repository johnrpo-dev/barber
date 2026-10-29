import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/session";

// Entrada del panel: cada rol aterriza donde trabaja. El tablero del dueño llega en el sprint 5.
export default async function PanelPage() {
  const staff = await requireStaff();
  redirect(staff.role === "barber" ? "/panel/mi-dia" : "/panel/agenda");
}
