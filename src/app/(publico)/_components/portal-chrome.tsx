import Link from "next/link";
import type { PortalView } from "../data";
import { telHref } from "../_lib/portal";
import { HeaderCta, type Cta } from "./cta";

// Cabecera y pie del portal público (docs/sprint-3-diseno-portal.md §0).

/** Qué hace el botón principal: reservar en línea o, si está apagada, llamar / escribir. */
export function primaryCta(portal: PortalView | null): Cta | null {
  if (portal?.enabled) return { href: "/reservar", label: "Reservar" };
  const tel = telHref(portal?.location.publicPhone);
  if (tel) return { href: tel, label: "Llámanos para reservar", external: true };
  if (portal?.location.whatsappUrl) return { href: portal.location.whatsappUrl, label: "Escríbenos para reservar", external: true };
  return null;
}

export function PortalHeader({ portal }: { portal: PortalView | null }) {
  const cta = primaryCta(portal);
  const headerCta: Cta | null = cta && !portal?.enabled ? { ...cta, label: "Llamar" } : cta;
  return (
    <header className="print:hidden">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="font-display text-2xl leading-none text-tinta">
          Villa
          <span className="sr-only">, inicio</span>
        </Link>
        {headerCta ? <HeaderCta cta={headerCta} /> : null}
      </div>
      <div aria-hidden className="h-0.5 bg-laton" />
    </header>
  );
}

export function PortalFooter({ portal }: { portal: PortalView | null }) {
  return (
    <footer className="mt-16 border-t border-tinta/10 bg-papel print:hidden">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-display text-xl">{portal?.location.name ?? "Villa"}</p>
          {portal?.location.address ? <p className="text-tinta/80">{portal.location.address}</p> : null}
        </div>
        <nav aria-label="Pie de página" className="flex items-center gap-1">
          <Link href="/privacidad" className="inline-flex min-h-11 items-center px-2 font-semibold underline-offset-4 hover:underline">
            Privacidad
          </Link>
          <Link href="/ingresar" className="inline-flex min-h-11 items-center px-2 text-xs text-tinta/70 underline-offset-4 hover:underline">
            Personal
          </Link>
        </nav>
      </div>
    </footer>
  );
}
