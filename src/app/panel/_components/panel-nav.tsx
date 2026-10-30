"use client";

import { CalendarDays, CalendarOff, CircleUserRound, LogOut, type LucideIcon, ReceiptText, Scissors, Settings, Sun, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

// Navegación del panel: barra inferior en celular; riel lateral desde tablet horizontal;
// barra lateral con texto en escritorio. Los ítems ya vienen filtrados por rol desde el servidor.

export type NavIcon = "agenda" | "mi-dia" | "bloqueos" | "servicios" | "personal" | "ajustes" | "caja" | "anulaciones";
export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Etiqueta corta para la barra inferior del celular (a 360 px caben ~7 ítems de 6 letras). */
  short?: string;
}

const ICONS: Record<NavIcon, LucideIcon> = {
  agenda: CalendarDays,
  "mi-dia": Sun,
  bloqueos: CalendarOff,
  servicios: Scissors,
  personal: Users,
  ajustes: Settings,
  caja: Wallet,
  anulaciones: ReceiptText,
};

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PanelNav({
  items,
  userName,
  roleLabel,
  signOut,
}: {
  items: NavItem[];
  userName: string;
  roleLabel: string;
  signOut: () => Promise<void>;
}) {
  const pathname = usePathname();
  const initials = userName
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <>
      {/* Riel / barra lateral (≥ lg) */}
      <nav
        aria-label="Principal"
        className="fixed inset-y-0 left-0 z-40 hidden w-[72px] flex-col border-r border-tinta/10 bg-papel lg:flex xl:w-[232px]"
      >
        <div className="flex h-16 items-center justify-center gap-2 border-b border-tinta/10 xl:justify-start xl:px-5">
          <span className="font-display text-2xl">V</span>
          <span className="hidden font-display text-2xl xl:inline">illa</span>
        </div>
        <ul className="flex flex-1 flex-col gap-1 p-2">
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-2 text-[11px] font-semibold transition-colors xl:min-h-12 xl:flex-row xl:justify-start xl:gap-3 xl:px-3 xl:text-sm",
                    active ? "bg-cuero/8 text-cuero" : "text-tinta/70 hover:bg-tinta/5 hover:text-tinta",
                  )}
                >
                  {active ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-cuero" aria-hidden /> : null}
                  <Icon size={20} strokeWidth={1.75} aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-col items-center gap-2 border-t border-tinta/10 p-3 xl:flex-row xl:items-center">
          <Link
            href="/cuenta"
            aria-label={`Mi cuenta: ${userName}, ${roleLabel}`}
            title="Mi cuenta"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg outline-none hover:bg-tinta/5 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cuero xl:p-1"
          >
            <span
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-botella text-sm font-semibold text-hueso"
              aria-hidden
            >
              {initials}
            </span>
            <span className="hidden min-w-0 flex-1 xl:block" aria-hidden>
              <span className="block truncate text-sm font-semibold">{userName}</span>
              <span className="block text-xs text-tinta/70">Mi cuenta · {roleLabel}</span>
            </span>
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="grid h-11 w-11 place-items-center rounded-lg text-tinta/70 hover:bg-tinta/5 hover:text-alerta"
              aria-label="Salir"
              title="Salir"
            >
              <LogOut size={20} strokeWidth={1.75} aria-hidden />
            </button>
          </form>
        </div>
      </nav>

      {/* Barra inferior (< lg) */}
      <nav
        aria-label="Principal"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-tinta/10 bg-papel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto flex h-16 max-w-xl items-stretch">
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href} className="min-w-0 flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "relative flex h-full flex-col items-center justify-center gap-0.5 font-semibold",
                    items.length > 5 ? "text-[10px] tracking-tight" : "text-[11px]",
                    active ? "text-cuero" : "text-tinta/70",
                  )}
                >
                  {active ? <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-cuero" aria-hidden /> : null}
                  <Icon size={22} strokeWidth={1.75} aria-hidden />
                  {item.short ? (
                    <>
                      <span aria-hidden className="max-w-full truncate px-0.5">
                        {item.short}
                      </span>
                      <span className="sr-only">{item.label}</span>
                    </>
                  ) : (
                    <span className="max-w-full truncate px-0.5">{item.label}</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

/** Encabezado móvil con la sede y el botón de salir (en escritorio vive en el riel). */
export function MobileTopBar({ locationName, signOut }: { locationName: string; signOut: () => Promise<void> }) {
  return (
    <div className="flex h-14 items-center justify-between border-b border-tinta/10 bg-hueso/95 px-4 backdrop-blur lg:hidden">
      <div className="flex items-baseline gap-2">
        <span className="font-display text-xl">Villa</span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-botella">{locationName}</span>
      </div>
      <div className="flex items-center">
        <Link href="/cuenta" className="grid h-11 w-11 place-items-center rounded-lg text-tinta/70" aria-label="Mi cuenta" title="Mi cuenta">
          <CircleUserRound size={20} strokeWidth={1.75} aria-hidden />
        </Link>
        <form action={signOut}>
          <button type="submit" className="grid h-11 w-11 place-items-center rounded-lg text-tinta/70" aria-label="Salir">
            <LogOut size={20} strokeWidth={1.75} aria-hidden />
          </button>
        </form>
      </div>
    </div>
  );
}
