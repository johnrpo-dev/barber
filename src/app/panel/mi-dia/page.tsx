import type { Metadata } from "next";
import { requireStaff } from "@/lib/session";
import { loadAgenda } from "../agenda/data";
import { MiDiaView } from "./mi-dia-view";

export const metadata: Metadata = { title: "Mi día" };

// El día del barbero: su siguiente cliente en grande y el resto en fila.
export default async function MiDiaPage() {
  const staff = await requireStaff();
  const view = await loadAgenda(staff, undefined, { ownOnly: true });
  return <MiDiaView view={view} name={staff.displayName} />;
}
