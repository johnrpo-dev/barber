import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MFA_REQUIRED } from "@/domain/staff/roles";
import { requireSignedInStaff, SETUP_PATHS } from "@/lib/session";
import { TwoFactorSetup } from "./two-factor-setup";

export const metadata: Metadata = { title: "Verificación en dos pasos · Villa" };

export default async function VerificacionPage() {
  // Sin requireStaff: aquí llega el dueño que aún no la activa. La contraseña temporal va primero.
  const staff = await requireSignedInStaff();
  if (staff.mustChangePassword) redirect(SETUP_PATHS.password);
  const required = MFA_REQUIRED[staff.role];

  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl leading-tight">Verificación en dos pasos</h1>
        <p className="text-sm text-tinta/80">
          {staff.twoFactorEnabled
            ? "Está activa: para ingresar se necesita tu contraseña y el código de tu app."
            : required
              ? "Como dueño tienes acceso a las cuentas. Antes de entrar al panel, protege tu cuenta con un código que cambia cada 30 segundos en tu celular."
              : "Opcional para tu rol: además de la contraseña, pide un código de tu celular."}
        </p>
      </header>
      <TwoFactorSetup enabled={staff.twoFactorEnabled} required={required} />
    </>
  );
}
