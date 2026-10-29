import { ArrowLeft, ChevronRight, KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ROLE_LABELS } from "@/domain/staff/roles";
import { requireStaff } from "@/lib/session";

export const metadata: Metadata = { title: "Mi cuenta · Villa" };

const row =
  "flex min-h-16 items-center gap-3 rounded-xl border border-tinta/10 bg-papel px-4 py-3 outline-none hover:border-tinta/25 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-cuero";

export default async function CuentaPage() {
  const staff = await requireStaff();
  return (
    <>
      <Link
        href="/panel"
        className="-ml-2 inline-flex h-11 items-center gap-1.5 self-start rounded-lg px-2 text-sm font-semibold text-tinta/70 hover:bg-tinta/5 hover:text-tinta"
      >
        <ArrowLeft size={16} aria-hidden />
        Volver al panel
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl leading-tight">{staff.displayName}</h1>
        <p className="text-sm text-tinta/80">
          {ROLE_LABELS[staff.role]} · <span className="break-all">{staff.email}</span>
        </p>
      </header>

      <nav aria-label="Seguridad de la cuenta" className="flex flex-col gap-2">
        <Link href="/cuenta/clave" className={row}>
          <KeyRound size={20} aria-hidden className="shrink-0 text-tinta/70" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-semibold">Cambiar contraseña</span>
            <span className="text-sm text-tinta/70">Cierra tus sesiones en otros dispositivos.</span>
          </span>
          <ChevronRight size={18} aria-hidden className="shrink-0 text-tinta/50" />
        </Link>
        <Link href="/cuenta/verificacion" className={row}>
          {staff.twoFactorEnabled ? (
            <ShieldCheck size={20} aria-hidden className="shrink-0 text-botella" />
          ) : (
            <ShieldAlert size={20} aria-hidden className="shrink-0 text-tinta/70" />
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-semibold">Verificación en dos pasos</span>
            <span className="text-sm text-tinta/70">
              {staff.twoFactorEnabled ? "Activa: además de la contraseña, pide el código de tu app." : "Inactiva: actívala para proteger tu cuenta."}
            </span>
          </span>
          <ChevronRight size={18} aria-hidden className="shrink-0 text-tinta/50" />
        </Link>
      </nav>
    </>
  );
}
