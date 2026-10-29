import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { locationRules } from "@/db/appointments";
import { listStaff } from "@/db/staff";
import { listTimeOff } from "@/db/time-off";
import type { Db } from "@/db/types";
import { businessDate } from "@/domain/ledger/business-date";
import { can } from "@/domain/staff/roles";
import { requireStaff } from "@/lib/session";
import { toTimeOffView } from "../personal/time-off-view";
import { type PersonTimeOff, TimeOffBoard } from "./time-off-board";

export const metadata: Metadata = { title: "Bloqueos · Villa" };

// Ausencias y bloqueos. Dueño y recepción ven a todo el equipo y los cierres de la sede;
// el barbero solo su propio tiempo.
export default async function BloqueosPage() {
  const staff = await requireStaff();
  const manageAll = can(staff.role, "time_off.manage.all");
  if (!manageAll && !can(staff.role, "time_off.manage.own")) redirect("/panel?sin-permiso=1");

  const conn = db() as unknown as Db;
  const now = new Date();
  const [members, { timeZone }, upcoming] = await Promise.all([
    listStaff(conn, staff.locationId),
    locationRules(conn, staff.locationId),
    listTimeOff(conn, { locationId: staff.locationId, ...(manageAll ? {} : { staffId: staff.staffId }), from: now }),
  ]);

  const people: PersonTimeOff[] = members
    .filter((m) => m.active && (manageAll || m.staffId === staff.staffId))
    .map((m) => ({
      id: m.staffId.toString(),
      name: m.displayName,
      isMe: m.staffId === staff.staffId,
      items: upcoming.filter((t) => t.staffId === m.staffId).map((t) => toTimeOffView(t, timeZone)),
    }))
    // Lo propio primero.
    .sort((a, b) => Number(b.isMe) - Number(a.isMe));

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <TimeOffBoard
        people={people}
        closures={manageAll ? upcoming.filter((t) => t.staffId === null).map((t) => toTimeOffView(t, timeZone)) : null}
        manageAll={manageAll}
        today={businessDate(now, timeZone)}
      />
    </main>
  );
}
