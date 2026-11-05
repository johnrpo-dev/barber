import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { locationRules } from "@/db/appointments";
import { listServices } from "@/db/catalog";
import { staffMember, staffServiceIds, weeklySchedule } from "@/db/staff";
import { listTimeOff } from "@/db/time-off";
import type { Db } from "@/db/types";
import { businessDate } from "@/domain/ledger/business-date";
import { format } from "@/domain/money";
import { formatTime } from "@/domain/staff/schedule";
import { idSchema } from "@/lib/action";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { requirePermission } from "@/lib/session";
import { toTimeOffView } from "../time-off-view";
import { StaffDetail } from "./staff-detail";

export const metadata: Metadata = { title: "Personal · Villa" };

export default async function StaffDetailPage({ params }: { params: Promise<{ staffId: string }> }) {
  const staff = await requirePermission("staff.manage");
  const parsed = idSchema.safeParse((await params).staffId);
  if (!parsed.success) notFound();
  const staffId = parsed.data;

  const conn = db() as unknown as Db;
  const member = await staffMember(conn, { locationId: staff.locationId, staffId });
  if (!member) notFound();

  const now = new Date();
  const [blocks, { timeZone }, upcoming, catalog, doing] = await Promise.all([
    weeklySchedule(conn, { locationId: staff.locationId, staffId }),
    locationRules(conn, staff.locationId),
    listTimeOff(conn, { locationId: staff.locationId, staffId, from: now }),
    listServices(conn, { locationId: staff.locationId }),
    staffServiceIds(conn, { locationId: staff.locationId, staffId }),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <StaffDetail
        member={{
          id: member.staffId.toString(),
          displayName: member.displayName,
          role: member.role,
          active: member.active,
          hasAppAccess: member.hasAppAccess,
          twoFactorEnabled: member.twoFactorEnabled,
          mustChangePassword: member.mustChangePassword,
          isMe: member.staffId === staff.staffId,
        }}
        minPasswordLength={MIN_PASSWORD_LENGTH}
        schedule={blocks.map((b) => ({ weekday: b.weekday, start: formatTime(b.startMin), end: formatTime(b.endMin) }))}
        timeOff={upcoming.map((t) => toTimeOffView(t, timeZone))}
        today={businessDate(now, timeZone)}
        services={catalog.map((s) => ({ id: s.id.toString(), name: s.name, durationLabel: `${s.durationMin} min`, priceLabel: format(s.price) }))}
        doing={doing.map(String)}
      />
    </main>
  );
}
