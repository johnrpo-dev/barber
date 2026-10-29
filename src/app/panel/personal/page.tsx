import type { Metadata } from "next";
import { db } from "@/db/client";
import { locationRules } from "@/db/appointments";
import { listStaff } from "@/db/staff";
import { listTimeOff } from "@/db/time-off";
import type { Db } from "@/db/types";
import { businessDate } from "@/domain/ledger/business-date";
import { isRole } from "@/domain/staff/roles";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { requirePermission } from "@/lib/session";
import { type StaffRow, StaffDirectory } from "./staff-directory";
import { toTimeOffView } from "./time-off-view";

export const metadata: Metadata = { title: "Personal · Villa" };

export default async function PersonalPage() {
  const staff = await requirePermission("staff.manage");
  const conn = db() as unknown as Db;
  const now = new Date();
  const [members, { timeZone }, upcoming] = await Promise.all([
    listStaff(conn, staff.locationId),
    locationRules(conn, staff.locationId),
    listTimeOff(conn, { locationId: staff.locationId, from: now }),
  ]);

  const rows: StaffRow[] = members.flatMap((m) =>
    isRole(m.role)
      ? [
          {
            id: m.staffId.toString(),
            displayName: m.displayName,
            role: m.role,
            active: m.active,
            hasAppAccess: m.userId !== null,
            isMe: m.staffId === staff.staffId,
          },
        ]
      : [],
  );
  const closures = upcoming.filter((t) => t.staffId === null).map((t) => toTimeOffView(t, timeZone));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <StaffDirectory
        staff={rows}
        closures={closures}
        today={businessDate(now, timeZone)}
        minPasswordLength={MIN_PASSWORD_LENGTH}
      />
    </main>
  );
}
