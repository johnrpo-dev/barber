import type { Metadata } from "next";
import { ToastProvider } from "@/app/panel/_components/ui";
import { getPortal } from "./_lib/portal";
import { PortalFooter, PortalHeader } from "./_components/portal-chrome";

// La cabecera y el pie leen la sede de la base: todo el portal se pinta por petición (y el build
// no necesita base de datos).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { template: "%s · Villa", default: "Villa Barbería" },
  description: "Reserva tu cita en Villa. Te confirmamos por WhatsApp.",
};

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const portal = await getPortal();
  return (
    <ToastProvider>
      <div className="flex min-h-dvh flex-col">
        <PortalHeader portal={portal} />
        <div className="flex-1">{children}</div>
        <PortalFooter portal={portal} />
      </div>
    </ToastProvider>
  );
}
