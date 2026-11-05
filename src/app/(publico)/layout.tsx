import type { Metadata } from "next";
import { ToastProvider } from "@/app/panel/_components/ui";
import { getPortal } from "./_lib/portal";
import { PortalFooter, PortalHeader } from "./_components/portal-chrome";
import { BUSINESS_NAME } from "@/domain/brand";

// La cabecera y el pie leen la sede de la base: todo el portal se pinta por petición (y el build
// no necesita base de datos).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { template: `%s · ${BUSINESS_NAME}`, default: BUSINESS_NAME },
  description: `Reserva tu cita en ${BUSINESS_NAME}. Te confirmamos por WhatsApp.`,
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
