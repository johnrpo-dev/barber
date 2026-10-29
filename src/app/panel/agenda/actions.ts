"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  appointmentHistory,
  availability,
  changeStatus,
  createAppointment,
  locationRules,
  rescheduleAppointment,
  walkIn,
} from "@/db/appointments";
import { db } from "@/db/client";
import { findOrCreateClient, searchClients } from "@/db/clients";
import type { Db } from "@/db/types";
import { isDateString, localMinuteOf, localMinuteToInstant } from "@/domain/booking/clock";
import { APPOINTMENT_STATUSES, STATUS_LABELS } from "@/domain/booking/status";
import { formatPhone, maskPhone } from "@/domain/clients/client";
import { businessDate } from "@/domain/ledger/business-date";
import { can } from "@/domain/staff/roles";
import { formatTime } from "@/domain/staff/schedule";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { requirePermission, requireStaff, type StaffContext } from "@/lib/session";

// Acciones de la agenda. Cada una vuelve a comprobar el permiso y toma la sede de la sesión,
// nunca del navegador. Los ids llegan como texto y se validan con zod.

const database = () => db() as unknown as Db;

function refresh() {
  revalidatePath("/panel/agenda");
  revalidatePath("/panel/mi-dia");
}

async function requireAgenda(): Promise<StaffContext> {
  const staff = await requireStaff();
  if (!can(staff.role, "appointments.manage.all") && !can(staff.role, "appointments.manage.own")) {
    redirect("/panel?sin-permiso=1");
  }
  return staff;
}

const actorOf = (staff: StaffContext) => ({ userId: staff.userId, role: staff.role, staffId: staff.staffId });

const dateSchema = z.string().refine(isDateString, "Fecha inválida");
const minuteSchema = z.number().int().min(0).max(24 * 60 - 1);
const staffChoice = z.union([z.literal("any"), idSchema]);
const idempotencyKey = z.string().min(8).max(100);

const clientChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), id: idSchema }),
  z.object({ kind: z.literal("new"), name: z.string().max(120), phone: z.string().max(30) }),
  z.object({ kind: z.literal("none"), name: z.string().max(120).optional() }),
]);

async function resolveClient(staff: StaffContext, choice: z.infer<typeof clientChoice>): Promise<bigint | null> {
  if (choice.kind === "existing") return choice.id;
  if (choice.kind === "new") {
    const client = await findOrCreateClient(database(), { locationId: staff.locationId, name: choice.name, phone: choice.phone });
    return client.id;
  }
  return null;
}

// ─── Lecturas ────────────────────────────────────────────────────────────────

export interface SlotOption {
  minute: number;
  label: string;
  staffIds: string[];
}

const slotsInput = z.object({
  serviceId: idSchema,
  staffId: staffChoice,
  date: dateSchema,
  excludeAppointmentId: idSchema.optional(),
});

export async function loadSlots(raw: z.input<typeof slotsInput>): Promise<ActionResult<SlotOption[]>> {
  const staff = await requirePermission("appointments.manage.all");
  return runAction(async () => {
    const input = slotsInput.parse(raw);
    const rules = await locationRules(database(), staff.locationId);
    const slots = await availability(database(), {
      locationId: staff.locationId,
      serviceId: input.serviceId,
      fromDate: input.date,
      toDate: input.date,
      staffId: input.staffId === "any" ? undefined : input.staffId,
      excludeAppointmentId: input.excludeAppointmentId,
      internal: true,
    });
    return slots.map((s) => {
      const minute = localMinuteOf(s.start, rules.timeZone);
      return { minute, label: formatTime(minute), staffIds: s.staffIds.map(String) };
    });
  });
}

export interface ClientOption {
  id: string;
  name: string;
  phone: string | null;
}

export async function findClients(query: string): Promise<ActionResult<ClientOption[]>> {
  const staff = await requirePermission("appointments.manage.all");
  return runAction(async () => {
    const q = z.string().max(80).parse(query);
    const seeContact = can(staff.role, "clients.view.contact");
    const rows = await searchClients(database(), { locationId: staff.locationId, query: q });
    return rows.map((c) => ({
      id: String(c.id),
      name: c.name,
      phone: c.phoneE164 ? (seeContact ? formatPhone(c.phoneE164) : maskPhone(c.phoneE164)) : null,
    }));
  });
}

export interface HistoryEntry {
  label: string;
  actor: string;
  at: string;
  reason: string | null;
}

export async function loadHistory(appointmentId: string): Promise<ActionResult<HistoryEntry[]>> {
  const staff = await requireAgenda();
  return runAction(async () => {
    const id = idSchema.parse(appointmentId);
    const rules = await locationRules(database(), staff.locationId);
    const events = await appointmentHistory(database(), {
      locationId: staff.locationId,
      appointmentId: id,
      staffId: can(staff.role, "appointments.manage.all") ? undefined : staff.staffId,
    });
    return events.map((e) => ({
      label:
        e.kind === "created"
          ? "Agendada"
          : e.kind === "rescheduled"
            ? "Reprogramada"
            : (STATUS_LABELS[e.toStatus as keyof typeof STATUS_LABELS] ?? e.toStatus ?? ""),
      actor: e.actorName ?? (e.actorKind === "system" ? "Sistema" : e.actorKind === "client" ? "Cliente" : "Personal"),
      at: `${businessDate(e.at, rules.timeZone)} ${formatTime(localMinuteOf(e.at, rules.timeZone))}`,
      reason: e.reason,
    }));
  });
}

// ─── Crear ───────────────────────────────────────────────────────────────────

const createInput = z.object({
  serviceId: idSchema,
  staffId: staffChoice,
  date: dateSchema,
  minute: minuteSchema,
  client: clientChoice,
  notes: z.string().max(500).optional(),
  allowOutsideHours: z.boolean().optional(),
  idempotencyKey,
});

export async function bookAppointment(
  raw: z.input<typeof createInput>,
): Promise<ActionResult<{ staffId: string; publicId: string; label: string }>> {
  const staff = await requirePermission("appointments.manage.all");
  const result = await runAction(async () => {
    const input = createInput.parse(raw);
    if (input.client.kind === "none") throw new z.ZodError([{ code: "custom", path: ["client"], message: "Elige o crea el cliente" }]);
    if (input.allowOutsideHours && input.staffId === "any") {
      throw new z.ZodError([{ code: "custom", path: ["staffId"], message: "Fuera del turno, elige un barbero" }]);
    }
    const rules = await locationRules(database(), staff.locationId);
    const clientId = await resolveClient(staff, input.client);
    const created = await createAppointment(database(), {
      locationId: staff.locationId,
      serviceId: input.serviceId,
      staffId: input.staffId,
      start: localMinuteToInstant(input.date, input.minute, rules.timeZone),
      clientId,
      source: "staff",
      notes: input.notes,
      idempotencyKey: input.idempotencyKey,
      createdBy: staff.userId,
      allowOutsideHours: input.allowOutsideHours,
    });
    return {
      staffId: String(created.staffId),
      publicId: created.publicId,
      label: formatTime(localMinuteOf(created.start, rules.timeZone)),
    };
  });
  if (result.ok) refresh();
  return result;
}

const walkInInput = z.object({
  serviceId: idSchema,
  staffId: staffChoice,
  client: clientChoice,
  idempotencyKey,
});

export async function startWalkIn(
  raw: z.input<typeof walkInInput>,
): Promise<ActionResult<{ staffId: string; label: string }>> {
  const staff = await requirePermission("appointments.manage.all");
  const result = await runAction(async () => {
    const input = walkInInput.parse(raw);
    const rules = await locationRules(database(), staff.locationId);
    const clientId = await resolveClient(staff, input.client);
    const created = await walkIn(database(), {
      locationId: staff.locationId,
      serviceId: input.serviceId,
      staffId: input.staffId,
      clientId,
      // Walk-in sin celular: el nombre queda como nota para llamarlo en la sala.
      notes: input.client.kind === "none" && input.client.name?.trim() ? `Cliente: ${input.client.name.trim()}` : undefined,
      idempotencyKey: input.idempotencyKey,
      createdBy: staff.userId,
    });
    return { staffId: String(created.staffId), label: formatTime(localMinuteOf(created.start, rules.timeZone)) };
  });
  if (result.ok) refresh();
  return result;
}

// ─── Cambios ─────────────────────────────────────────────────────────────────

const statusInput = z.object({
  appointmentId: idSchema,
  to: z.enum(APPOINTMENT_STATUSES),
  cancelReason: z.enum(["client", "staff", "left", "duplicate"]).optional(),
  note: z.string().max(300).optional(),
});

export async function setStatus(raw: z.input<typeof statusInput>): Promise<ActionResult> {
  const staff = await requireAgenda();
  const result = await runAction(async () => {
    const input = statusInput.parse(raw);
    await changeStatus(database(), {
      locationId: staff.locationId,
      appointmentId: input.appointmentId,
      to: input.to,
      actor: actorOf(staff),
      cancelReason: input.cancelReason,
      note: input.note,
    });
    return undefined;
  });
  if (result.ok) refresh();
  return result;
}

const rescheduleInput = z.object({
  appointmentId: idSchema,
  staffId: idSchema,
  date: dateSchema,
  minute: minuteSchema,
  allowOutsideHours: z.boolean().optional(),
});

export async function reschedule(raw: z.input<typeof rescheduleInput>): Promise<ActionResult<{ label: string }>> {
  const staff = await requirePermission("appointments.manage.all");
  const result = await runAction(async () => {
    const input = rescheduleInput.parse(raw);
    const rules = await locationRules(database(), staff.locationId);
    await rescheduleAppointment(database(), {
      locationId: staff.locationId,
      appointmentId: input.appointmentId,
      staffId: input.staffId,
      start: localMinuteToInstant(input.date, input.minute, rules.timeZone),
      actor: actorOf(staff),
      allowOutsideHours: input.allowOutsideHours,
    });
    return { label: formatTime(input.minute) };
  });
  if (result.ok) refresh();
  return result;
}
