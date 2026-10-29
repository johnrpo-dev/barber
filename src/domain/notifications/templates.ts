// Plantillas de mensajes al cliente (sprint-3-diseno-portal.md §6). Ningún texto libre del
// usuario: la plantilla del código NO lleva el nombre (si alguien pone un teléfono ajeno, la
// víctima no recibe texto del atacante) y las demás llevan solo el primer nombre saneado.
// Los parámetros llegan ya formateados (fecha y hora en la zona de la sede) y siempre como texto.

export const NOTIFICATION_TEMPLATES = [
  "otp",
  "booking_confirmed",
  "reminder_24h",
  "reminder_2h",
  "appointment_rescheduled",
  "appointment_cancelled_client",
  "appointment_cancelled_staff",
] as const;
export type NotificationTemplate = (typeof NOTIFICATION_TEMPLATES)[number];

export const NOTIFICATION_CHANNELS = ["whatsapp", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Nombres aprobados en Meta (idioma `es`). */
export const WHATSAPP_TEMPLATE_NAMES: Record<NotificationTemplate, string> = {
  otp: "villa_otp",
  booking_confirmed: "villa_reserva_confirmada",
  reminder_24h: "villa_recordatorio_24h",
  reminder_2h: "villa_recordatorio_2h",
  appointment_rescheduled: "villa_cita_reprogramada",
  appointment_cancelled_client: "villa_cita_cancelada",
  appointment_cancelled_staff: "villa_cita_cancelada_sede",
};

/**
 * Parámetros obligatorios de cada plantilla, en el orden de las variables {{1}}, {{2}}… de
 * WhatsApp. `url` va al final y no es variable del cuerpo: es el botón.
 */
export const TEMPLATE_PARAMS: Record<NotificationTemplate, readonly string[]> = {
  otp: ["code"],
  booking_confirmed: ["name", "service", "staff", "date", "time", "ticket", "url"],
  reminder_24h: ["name", "time", "service", "staff", "url"],
  reminder_2h: ["name", "time", "address", "url"],
  appointment_rescheduled: ["name", "service", "staff", "date", "time", "url"],
  appointment_cancelled_client: ["name", "date", "time", "url"],
  appointment_cancelled_staff: ["name", "date", "time"],
};

const MAX_FIRST_NAME = 30;

/** "  maría josé  pérez" → "maría"; solo letras (con tildes y ñ), hasta 30. "" si no queda nada. */
export function firstNameForMessage(name: string): string {
  const word = name.normalize("NFC").trim().split(/\s+/)[0] ?? "";
  return Array.from(word.replace(/[^\p{L}]/gu, ""))
    .slice(0, MAX_FIRST_NAME)
    .join("");
}

interface EmailCopy {
  subject: string;
  paragraphs: string[];
  /** El ticket como tabla. */
  rows?: [label: string, value: string][];
  button?: { label: string; url: string };
  footer?: string;
}

type Get = (key: string) => string;

const COPY: Record<NotificationTemplate, (p: Get) => EmailCopy> = {
  otp: (p) => ({
    subject: `Tu código de Villa: ${p("code")}`,
    paragraphs: [`${p("code")} es tu código de verificación. Por tu seguridad, no lo compartas.`],
    footer: "Este código caduca en 5 minutos. Si no estás reservando en Villa, ignora este mensaje.",
  }),
  booking_confirmed: (p) => ({
    subject: `Cita confirmada: ${p("date")} a las ${p("time")}`,
    paragraphs: [
      `¡Listo, ${p("name")}! Tu cita en Villa quedó confirmada: ${p("service")} con ${p("staff")}, el ${p("date")} a las ${p("time")}. Tu código de turno es ${p("ticket")}.`,
      "Si necesitas reprogramar o cancelar, usa el botón.",
    ],
    rows: [
      ["Servicio", p("service")],
      ["Barbero", p("staff")],
      ["Fecha", p("date")],
      ["Hora", p("time")],
      ["Código de turno", p("ticket")],
    ],
    button: { label: "Ver mi cita", url: p("url") },
  }),
  reminder_24h: (p) => ({
    subject: `Mañana a las ${p("time")}: tu turno en Villa`,
    paragraphs: [
      `Hola, ${p("name")}. Te esperamos mañana a las ${p("time")} en Villa para tu ${p("service")} con ${p("staff")}.`,
      "Si no puedes venir, avísanos desde el botón y liberamos el turno.",
    ],
    button: { label: "Ver mi cita", url: p("url") },
  }),
  reminder_2h: (p) => ({
    subject: `Hoy a las ${p("time")}: te esperamos`,
    paragraphs: [`Hola, ${p("name")}. Tu turno en Villa es hoy a las ${p("time")}. Estamos en ${p("address")}. ¡Nos vemos!`],
    button: { label: "Ver mi cita", url: p("url") },
  }),
  appointment_rescheduled: (p) => ({
    subject: `Cita reprogramada: ${p("date")} a las ${p("time")}`,
    paragraphs: [
      `Hola, ${p("name")}. Movimos tu cita en Villa: ${p("service")} con ${p("staff")}, el ${p("date")} a las ${p("time")}.`,
      "Si necesitas otro cambio, usa el botón.",
    ],
    rows: [
      ["Servicio", p("service")],
      ["Barbero", p("staff")],
      ["Fecha", p("date")],
      ["Hora", p("time")],
    ],
    button: { label: "Ver mi cita", url: p("url") },
  }),
  appointment_cancelled_client: (p) => ({
    subject: `Cancelamos tu cita del ${p("date")}`,
    paragraphs: [`Hola, ${p("name")}. Cancelamos tu cita del ${p("date")} a las ${p("time")}. Cuando quieras volver, reserva desde el botón.`],
    button: { label: "Reservar", url: p("url") },
  }),
  appointment_cancelled_staff: (p) => ({
    subject: `Cancelamos tu cita del ${p("date")}`,
    paragraphs: [`Lo sentimos, ${p("name")}. Tuvimos que cancelar tu cita del ${p("date")} a las ${p("time")}. Escríbenos y te buscamos otro turno.`],
  }),
};

/** Sin saltos de línea ni controles: nada de inyección de cabeceras en el asunto. */
function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const C = { hueso: "#f4efe6", papel: "#fbf8f3", tinta: "#1c1a17", cuero: "#8a4b2a", laton: "#b8893b" };

function html(copy: EmailCopy): string {
  const e = escapeHtml;
  const paragraphs = copy.paragraphs.map((t) => `<p style="margin:0 0 16px">${e(t)}</p>`).join("");
  const rows = copy.rows
    ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 20px;border-top:2px dashed ${C.laton}">${copy.rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding:8px 0;color:${C.tinta};opacity:.7">${e(k)}</td><td style="padding:8px 0;text-align:right;font-weight:600">${e(v)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const button = copy.button
    ? `<p style="margin:0 0 16px"><a href="${e(copy.button.url)}" style="display:inline-block;background:${C.cuero};color:${C.papel};padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600">${e(copy.button.label)}</a></p>`
    : "";
  const footer = copy.footer ? `<p style="margin:16px 0 0;font-size:14px;opacity:.7">${e(copy.footer)}</p>` : "";
  return (
    `<!doctype html><html lang="es"><body style="margin:0;background:${C.hueso};color:${C.tinta};font-family:Georgia,serif">` +
    `<div style="max-width:480px;margin:0 auto;padding:24px 16px">` +
    `<p style="margin:0 0 4px;font-size:24px">Villa</p><div style="height:2px;background:${C.laton};margin:0 0 24px"></div>` +
    `<div style="background:${C.papel};border-radius:16px;padding:24px;font-family:system-ui,sans-serif;font-size:16px;line-height:1.5">` +
    `${paragraphs}${rows}${button}${footer}</div>` +
    `<p style="margin:16px 0 0;font-family:system-ui,sans-serif;font-size:13px;opacity:.7">Villa Barbería. Mensaje de servicio sobre tu cita.</p>` +
    `</div></body></html>`
  );
}

function text(copy: EmailCopy): string {
  const parts = [...copy.paragraphs];
  if (copy.rows) parts.push(copy.rows.map(([k, v]) => `${k}: ${v}`).join("\n"));
  if (copy.button) parts.push(`${copy.button.label}: ${copy.button.url}`);
  if (copy.footer) parts.push(copy.footer);
  parts.push("Villa Barbería");
  return parts.join("\n\n");
}

/** Correo listo para enviar. Lanza si falta un parámetro o el enlace no es http(s). */
export function renderEmail(template: NotificationTemplate, params: Record<string, string>): { subject: string; text: string; html: string } {
  const values = new Map<string, string>();
  for (const key of TEMPLATE_PARAMS[template]) {
    const raw = params[key];
    const v = raw === undefined ? "" : clean(raw);
    if (!v) throw new Error(`Falta el parámetro "${key}" de la plantilla ${template}`);
    if (key === "url" && !/^https?:\/\/[^\s]+$/i.test(v)) throw new Error(`El enlace de la plantilla ${template} no es http(s)`);
    values.set(key, v);
  }
  // Solo los parámetros declarados: lo que sobre (por ejemplo el nombre en el código) no se usa.
  const copy = COPY[template]((key) => {
    const v = values.get(key);
    if (v === undefined) throw new Error(`La plantilla ${template} usa "${key}" sin declararlo`);
    return v;
  });
  return { subject: copy.subject, text: text(copy), html: html(copy) };
}
