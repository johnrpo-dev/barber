import type { Metadata } from "next";
import { can, type Permission, ROLE_LABELS } from "@/domain/staff/roles";
import { requireStaff } from "@/lib/session";
import { signOut } from "./actions";

export const metadata: Metadata = { title: "Panel · Villa" };

// Secciones del panel según permiso. Las que aún no existen se muestran como "próximamente"
// para que el dueño vea desde ya qué podrá hacer cada rol.
const SECTIONS: { title: string; detail: string; permission: Permission }[] = [
  { title: "Agenda del día", detail: "Citas de todos los barberos", permission: "appointments.manage.all" },
  { title: "Mis citas", detail: "Tu agenda de hoy", permission: "appointments.manage.own" },
  { title: "Cobrar", detail: "Registrar ventas y medios de pago", permission: "ledger.post" },
  { title: "Cierre de caja", detail: "Cuadre del efectivo del día", permission: "day.close" },
  { title: "Informes", detail: "Ingresos, gastos y utilidad", permission: "reports.financial" },
  { title: "Mis comisiones", detail: "Lo que llevas ganado", permission: "commissions.view.own" },
  { title: "Servicios y precios", detail: "Catálogo y comisiones", permission: "services.manage" },
  { title: "Personal", detail: "Barberos, roles y horarios", permission: "staff.manage" },
];

export default async function PanelPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const staff = await requireStaff();
  const { "sin-permiso": denied } = await searchParams;
  const sections = SECTIONS.filter((s) => can(staff.role, s.permission));

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-4 py-8">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-botella">{ROLE_LABELS[staff.role]}</p>
          <h1 className="font-display text-3xl">Hola, {staff.displayName.split(" ")[0]}</h1>
        </div>
        <form action={signOut}>
          <button
            type="submit"
            className="h-11 rounded-lg border border-tinta/25 px-4 text-sm font-semibold hover:border-cuero hover:text-cuero"
          >
            Salir
          </button>
        </form>
      </header>

      {denied ? (
        <p role="alert" className="rounded-lg border border-cuero/40 bg-cuero/10 p-3 text-sm">
          Tu rol no tiene acceso a esa sección.
        </p>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2">
        {sections.map((s) => (
          <li key={s.title} className="flex flex-col gap-1 rounded-lg border border-tinta/15 bg-white p-4">
            <span className="font-semibold">{s.title}</span>
            <span className="text-sm text-tinta/70">{s.detail}</span>
            <span className="mt-2 text-xs font-semibold uppercase tracking-wider text-botella">Próximamente</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
