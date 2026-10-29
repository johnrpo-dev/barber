import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { sessionState } from "@/lib/session";
import { signOut } from "../panel/actions";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Ingresar · Villa" };

export default async function IngresarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const state = await sessionState();
  if (state.status === "staff") redirect("/panel");
  const { "sin-acceso": noAccess } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 px-4 py-10">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-botella">Personal</p>
        <h1 className="font-display text-4xl">Villa</h1>
        <div className="h-px w-16 bg-laton" aria-hidden />
      </header>

      {state.status === "no-access" || noAccess ? (
        <section className="flex flex-col gap-4 rounded-lg border border-tinta/15 bg-white p-4">
          <p>Tu cuenta no tiene acceso activo a la barbería. Habla con el dueño.</p>
          <form action={signOut}>
            <button type="submit" className="text-sm font-semibold text-cuero underline underline-offset-4">
              Salir
            </button>
          </form>
        </section>
      ) : (
        <LoginForm />
      )}
    </main>
  );
}
