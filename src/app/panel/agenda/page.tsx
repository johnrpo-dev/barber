import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { can } from "@/domain/staff/roles";
import { requireStaff } from "@/lib/session";
import { AgendaBoard } from "./_components/agenda-board";
import { loadAgenda } from "./data";

export const metadata: Metadata = { title: "Agenda" };

export default async function AgendaPage({ searchParams }: { searchParams: Promise<{ fecha?: string | string[] }> }) {
  const staff = await requireStaff();
  if (!can(staff.role, "appointments.manage.all") && !can(staff.role, "appointments.manage.own")) {
    redirect("/panel?sin-permiso=1");
  }
  const { fecha } = await searchParams;
  const view = await loadAgenda(staff, fecha);
  return <AgendaBoard key={view.date} view={view} />;
}
