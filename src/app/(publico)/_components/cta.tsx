"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cx, linkBtn } from "../_lib/ui";

// Las dos únicas islas de cliente del inicio y la cabecera.

export type Cta = { href: string; label: string; external?: boolean };

function CtaLink({ cta, className }: { cta: Cta; className: string }) {
  return cta.external ? (
    <a href={cta.href} className={className}>
      {cta.label}
    </a>
  ) : (
    <Link href={cta.href} className={className}>
      {cta.label}
    </Link>
  );
}

/** "Reservar" de la cabecera. Dentro del flujo de reserva sobra: ahí no se muestra. */
export function HeaderCta({ cta }: { cta: Cta }) {
  const pathname = usePathname();
  if (pathname.startsWith("/reservar")) return null;
  return <CtaLink cta={cta} className={linkBtn("primary", "sm")} />;
}

/** Barra fija de móvil: aparece con "Reservar" cuando el hero sale de la pantalla. */
export function StickyCta({ cta, watchId }: { cta: Cta; watchId: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const target = document.getElementById(watchId);
    if (!target || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setVisible(!entry?.isIntersecting), { threshold: 0 });
    io.observe(target);
    return () => io.disconnect();
  }, [watchId]);
  return (
    <div
      className={cx(
        "fixed inset-x-0 bottom-0 z-30 border-t border-tinta/10 bg-papel/95 px-4 pt-3 pb-[max(.75rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden",
        visible ? "animate-fade-in" : "hidden",
      )}
    >
      <CtaLink cta={cta} className={linkBtn("primary", "lg", "w-full")} />
    </div>
  );
}
