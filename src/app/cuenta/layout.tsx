import { LogOut } from "lucide-react";
import { signOut } from "../panel/actions";
import { ToastProvider } from "../panel/_components/ui";

// Cuenta propia: fuera de /panel para poder completar la contraseña temporal y la verificación en
// dos pasos antes de que el panel deje entrar (requireStaff redirige aquí).

export default function CuentaLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="flex min-h-dvh flex-col">
        <header className="flex h-14 items-center justify-between border-b border-tinta/10 bg-hueso/95 px-4">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-xl">Villa</span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-botella">Mi cuenta</span>
          </div>
          <form action={signOut}>
            <button type="submit" className="flex h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-tinta/70 hover:bg-tinta/5">
              <LogOut size={18} strokeWidth={1.75} aria-hidden />
              Salir
            </button>
          </form>
        </header>
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-4 py-6 md:py-10">{children}</main>
      </div>
    </ToastProvider>
  );
}
