import type { Metadata } from "next";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { requireSignedInStaff } from "@/lib/session";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Contraseña · Villa" };

export default async function ClavePage() {
  // Sin requireStaff: aquí llega quien tiene la contraseña temporal pendiente.
  const staff = await requireSignedInStaff();
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl leading-tight">{staff.mustChangePassword ? "Crea tu contraseña" : "Cambiar contraseña"}</h1>
        <p className="text-sm text-tinta/80">
          {staff.mustChangePassword
            ? "Ingresaste con una contraseña temporal. Antes de seguir, crea una que solo tú sepas."
            : "Al cambiarla se cierran tus sesiones en otros dispositivos; esta sigue abierta."}
        </p>
      </header>
      <PasswordForm forced={staff.mustChangePassword} minPasswordLength={MIN_PASSWORD_LENGTH} />
    </>
  );
}
