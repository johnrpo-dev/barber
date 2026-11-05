// Política de tratamiento de datos (Ley 1581 de 2012 y Decreto 1377 de 2013), versionada.
// Una versión publicada NO se edita: client_consents.text_version apunta a ella y es la prueba
// de lo que la persona aceptó. Para cambiar el texto se agrega una versión nueva al final.
// Un test congela el SHA-256 de cada versión publicada.
// Los datos entre corchetes los completa el dueño con su abogado antes de abrir la reserva.

import { BACKUP_RETENTION_MONTHS, PII_RETENTION_DAYS, READ_AUDIT_RETENTION_DAYS } from "@/domain/clients/retention";

export interface PrivacyVersion {
  version: string;
  /** Fecha de entrada en vigencia (AAAA-MM-DD, hora de Colombia). */
  publishedOn: string;
  title: string;
  sections: readonly { id: string; heading: string; paragraphs: readonly string[] }[];
}

/** Primera versión publicada (congelada). */
const V_2026_11_01: PrivacyVersion = {
    version: "2026-11-01",
    publishedOn: "2026-11-01",
    title: "Política de tratamiento de datos personales",
    sections: [
      {
        id: "responsable",
        heading: "Quién es el responsable",
        paragraphs: [
          "El responsable del tratamiento de tus datos es [Razón social], identificada con NIT [NIT], con domicilio en [Dirección], que opera la barbería Villa.",
          "Para cualquier consulta o reclamo sobre tus datos escríbenos a [Correo de habeas data]. Ese canal lo atiende directamente la administración de la barbería.",
        ],
      },
      {
        id: "datos",
        heading: "Qué datos recogemos",
        paragraphs: [
          "Tu nombre y tu número de celular, para agendar y avisarte. Tu correo electrónico, solo si decides dárnoslo.",
          "El historial de tus citas: servicio, barbero, fecha, hora y estado.",
          "Cuando autorizas el tratamiento guardamos la dirección IP y el navegador desde los que lo hiciste, como prueba de tu autorización.",
          "No te pedimos datos sensibles ni datos de niños, niñas o adolescentes.",
        ],
      },
      {
        id: "finalidades",
        heading: "Para qué los usamos",
        paragraphs: [
          "Para gestionar tus citas: reservarlas, reprogramarlas, cancelarlas y atenderte en la barbería.",
          "Para enviarte el código que confirma que el celular es tuyo, la confirmación de tu cita y los avisos de cambios o cancelaciones.",
          "Estos usos son necesarios para reservar en línea. Sin esta autorización no podemos agendarte por aquí, pero siempre puedes reservar por teléfono.",
        ],
      },
      {
        id: "recordatorios",
        heading: "Recordatorios y promociones",
        paragraphs: [
          "Los recordatorios antes de tu cita y las promociones son autorizaciones aparte. Ambas son opcionales y vienen sin marcar.",
          "Puedes aceptarlas o no sin que eso cambie tu reserva, y puedes revocarlas cuando quieras escribiendo a [Correo de habeas data].",
        ],
      },
      {
        id: "derechos",
        heading: "Tus derechos",
        paragraphs: [
          "Como titular de los datos puedes conocerlos, actualizarlos y rectificarlos.",
          "Puedes pedir que los suprimamos y revocar tu autorización, siempre que no tengamos un deber legal o contractual de conservarlos.",
          "Puedes solicitar prueba de la autorización que nos diste y saber qué uso les hemos dado a tus datos.",
          "Puedes acceder a tus datos de forma gratuita.",
          "Puedes presentar quejas ante la Superintendencia de Industria y Comercio (SIC), después de haber hecho tu consulta o reclamo ante nosotros.",
        ],
      },
      {
        id: "ejercicio",
        heading: "Cómo ejercerlos",
        paragraphs: [
          "Escríbenos a [Correo de habeas data] con tu nombre, tu número de celular y lo que necesitas. Si actúas en nombre de otra persona, acredita que puedes hacerlo.",
          "Las consultas se responden en un máximo de 10 días hábiles desde que las recibimos. Si no alcanzamos, te avisamos el motivo y respondemos dentro de los 5 días hábiles siguientes.",
          "Los reclamos (corregir, actualizar, suprimir o revocar) se resuelven en un máximo de 15 días hábiles. Si no alcanzamos, te avisamos el motivo y resolvemos dentro de los 8 días hábiles siguientes.",
        ],
      },
      {
        id: "encargados",
        heading: "Quién más trata tus datos por nosotros",
        paragraphs: [
          "Meta Platforms (WhatsApp), para enviarte el código, la confirmación y los avisos de tu cita.",
          "Nuestro proveedor de correo electrónico, si nos diste tu correo.",
          "Nuestro proveedor de alojamiento (hosting), donde funciona el sistema de citas.",
          "Algunos de ellos guardan la información fuera de Colombia. Solo la usan para prestarnos el servicio, bajo acuerdos que les exigen protegerla como lo pide la ley colombiana.",
        ],
      },
      {
        id: "conservacion",
        heading: "Cuánto tiempo guardamos tus datos",
        paragraphs: [
          "Las citas y la información contable se conservan durante el tiempo que exijan las normas contables y tributarias.",
          "Si iniciaste una reserva y nunca confirmaste el código, anonimizamos tus datos a los 7 días.",
          "Lo demás lo conservamos mientras sigas siendo cliente o hasta que pidas suprimirlo, salvo un deber legal de guardarlo.",
        ],
      },
      {
        id: "cambios",
        heading: "Cambios a esta política",
        paragraphs: [
          "Esta política rige desde el 1 de noviembre de 2026.",
          "Si la cambiamos, publicaremos la versión nueva en esta página con su fecha. Las versiones anteriores siguen disponibles. Si el cambio afecta las finalidades, te pediremos una autorización nueva.",
        ],
      },
    ],
  };

/**
 * Sprint 5: dice cuánto guardamos los restos de la reserva en línea y el registro de quién vio tu
 * celular. Los días salen de src/domain/clients/retention.ts (los mismos que hace cumplir la base,
 * migración 0012); cambiarlos cambia el texto y obliga a publicar una versión nueva (test FROZEN).
 * Las finalidades no cambian: no hace falta pedir una autorización nueva.
 */
const V_2026_11_02: PrivacyVersion = {
  ...V_2026_11_01,
  version: "2026-11-02",
  publishedOn: "2026-11-02",
  sections: V_2026_11_01.sections.map((section) => {
    if (section.id === "conservacion") {
      return {
        ...section,
        paragraphs: [
          "Las citas y la información contable se conservan durante el tiempo que exijan las normas contables y tributarias.",
          "Si iniciaste una reserva y nunca confirmaste el código, anonimizamos tus datos a los 7 días.",
          `La dirección IP, el navegador, el nombre y el correo que escribiste al pedir el código, y el contenido de los mensajes que te enviamos, los borramos a los ${PII_RETENTION_DAYS} días. La prueba de tu autorización (qué aceptaste, cuándo, y desde qué IP y navegador) la conservamos mientras tratemos tus datos.`,
          `Registramos qué persona de nuestro equipo vio tu número de celular completo y cuándo, para poder responderte si preguntas quién usó tus datos. Ese registro se borra a los ${READ_AUDIT_RETENTION_DAYS} días.`,
          "Si pides suprimir tus datos, borramos también esos registros de tu reserva en línea, sin esperar esos plazos, salvo un deber legal de guardarlos.",
          "Lo demás lo conservamos mientras sigas siendo cliente o hasta que pidas suprimirlo, salvo un deber legal de guardarlo.",
        ],
      };
    }
    if (section.id === "cambios") {
      return {
        ...section,
        paragraphs: [
          "Esta política rige desde el 2 de noviembre de 2026. La versión anterior (1 de noviembre de 2026) no decía cuánto tiempo guardamos los datos de la reserva en línea ni el registro de consultas; las finalidades no cambiaron.",
          "Si la cambiamos, publicaremos la versión nueva en esta página con su fecha. Las versiones anteriores siguen disponibles. Si el cambio afecta las finalidades, te pediremos una autorización nueva.",
        ],
      };
    }
    return section;
  }),
};

/**
 * Auditoría del sprint 5: dice cuánto viven los datos en las copias de seguridad y qué pasa con una
 * supresión en ellas. Las finalidades no cambian: no hace falta pedir una autorización nueva.
 */
const V_2026_11_03: PrivacyVersion = {
  ...V_2026_11_02,
  version: "2026-11-03",
  publishedOn: "2026-11-03",
  sections: V_2026_11_02.sections.map((section) => {
    if (section.id === "conservacion") {
      return {
        ...section,
        paragraphs: [
          ...section.paragraphs,
          `Guardamos copias de seguridad cifradas, en un proveedor de almacenamiento externo, hasta por ${BACKUP_RETENTION_MONTHS} meses. Solo las usamos para recuperar el servicio si algo falla. Tus datos salen de ellas cuando cada copia vence: no se pueden borrar antes de una copia ya hecha.`,
          "Si pides suprimir tus datos y luego tenemos que recuperar una copia anterior, volvemos a aplicar tu supresión antes de seguir usándola.",
        ],
      };
    }
    if (section.id === "cambios") {
      return {
        ...section,
        paragraphs: [
          "Esta política rige desde el 3 de noviembre de 2026. La versión anterior (2 de noviembre de 2026) no decía cuánto tiempo guardamos las copias de seguridad; las finalidades no cambiaron.",
          "Si la cambiamos, publicaremos la versión nueva en esta página con su fecha. Las versiones anteriores siguen disponibles. Si el cambio afecta las finalidades, te pediremos una autorización nueva.",
        ],
      };
    }
    return section;
  }),
};

/**
 * Sprint 6: el nombre del negocio es "Barbería Villa" y ya no hay recordatorios antes de la cita
 * (decisión del dueño): solo el código, la confirmación y los avisos si la cita cambia o se cancela.
 * Las finalidades se reducen, no se amplían: no hace falta pedir una autorización nueva.
 */
const V_2026_11_05: PrivacyVersion = {
  ...V_2026_11_03,
  version: "2026-11-05",
  publishedOn: "2026-11-05",
  sections: V_2026_11_03.sections.map((section) => {
    if (section.id === "responsable") {
      return {
        ...section,
        paragraphs: [
          "El responsable del tratamiento de tus datos es [Razón social], identificada con NIT [NIT], con domicilio en [Dirección], que opera Barbería Villa.",
          ...section.paragraphs.slice(1),
        ],
      };
    }
    if (section.id === "recordatorios") {
      return {
        ...section,
        heading: "Sin recordatorios ni mensajes de más",
        paragraphs: [
          "No te enviamos recordatorios antes de tu cita. Solo te escribimos para lo necesario: el código que confirma tu celular, la confirmación de tu cita y un aviso si tu cita cambia o se cancela. Si lo pides en la barbería, también te enviamos el recibo de tu visita.",
          "Las promociones son una autorización aparte, opcional y sin marcar. Puedes aceptarlas o no sin que eso cambie tu reserva, y puedes revocarlas cuando quieras escribiendo a [Correo de habeas data].",
        ],
      };
    }
    if (section.id === "cambios") {
      return {
        ...section,
        paragraphs: [
          "Esta política rige desde el 5 de noviembre de 2026. La versión anterior (3 de noviembre de 2026) ofrecía recordatorios antes de la cita; ya no los enviamos. Las demás finalidades no cambiaron.",
          "Si la cambiamos, publicaremos la versión nueva en esta página con su fecha. Las versiones anteriores siguen disponibles. Si el cambio afecta las finalidades, te pediremos una autorización nueva.",
        ],
      };
    }
    return section;
  }),
};

/**
 * Sprint 6, segunda del mismo día (veredicto del council, aprobado por el dueño): vuelve UN solo
 * recordatorio, unas 3 horas antes y solo si la cita se apartó con más de 6 horas. Va dentro de la
 * finalidad obligatoria (gestionar la cita), no como casilla aparte. Es una finalidad nueva frente a
 * la versión anterior: quien autorizó con esa no lo recibe hasta que acepte esta (en su próxima
 * reserva desde un celular nuevo, que vuelve a pedir la autorización).
 */
const V_2026_11_05B: PrivacyVersion = {
  ...V_2026_11_05,
  version: "2026-11-05b",
  publishedOn: "2026-11-05",
  sections: V_2026_11_05.sections.map((section) => {
    if (section.id === "finalidades") {
      return {
        ...section,
        paragraphs: [
          "Para gestionar tus citas: reservarlas, reprogramarlas, cancelarlas y atenderte en la barbería.",
          "Para escribirte por WhatsApp o correo lo necesario: el código que confirma que el celular es tuyo, la confirmación de tu cita, un recordatorio ese mismo día y los avisos de cambios o cancelaciones.",
          "Estos usos son necesarios para reservar en línea. Sin esta autorización no podemos agendarte por aquí, pero siempre puedes reservar por teléfono.",
        ],
      };
    }
    if (section.id === "recordatorios") {
      return {
        ...section,
        heading: "Un solo recordatorio, sin mensajes de más",
        paragraphs: [
          "Te enviamos un único recordatorio unas 3 horas antes de tu cita, y solo si la reservaste (o la cambiaste) con más de 6 horas de anticipación: si reservas para dentro de un rato, la confirmación basta. No te escribimos nada más antes de la cita.",
          "Si no quieres el recordatorio, escríbenos a [Correo de habeas data] y lo desactivamos; tu reserva no cambia.",
          "Las promociones son una autorización aparte, opcional y sin marcar. Puedes aceptarlas o no sin que eso cambie tu reserva, y puedes revocarlas cuando quieras escribiendo a [Correo de habeas data].",
        ],
      };
    }
    if (section.id === "cambios") {
      return {
        ...section,
        paragraphs: [
          "Esta política rige desde el 5 de noviembre de 2026 (versión 2026-11-05b). La versión anterior, del mismo día, no incluía recordatorios; esta agrega uno solo, el día de la cita. Si autorizaste con la anterior, no te lo enviamos hasta que aceptes esta.",
          "Si la cambiamos, publicaremos la versión nueva en esta página con su fecha. Las versiones anteriores siguen disponibles. Si el cambio afecta las finalidades, te pediremos una autorización nueva.",
        ],
      };
    }
    return section;
  }),
};

export const PRIVACY_VERSIONS: readonly PrivacyVersion[] = [V_2026_11_01, V_2026_11_02, V_2026_11_03, V_2026_11_05, V_2026_11_05B];

const LATEST = PRIVACY_VERSIONS[PRIVACY_VERSIONS.length - 1]!;

/** La versión vigente: la última de la lista. Es lo que se guarda en client_consents.text_version. */
export const CURRENT_PRIVACY_VERSION: string = LATEST.version;
export const CURRENT_PRIVACY: PrivacyVersion = LATEST;

export function privacyVersion(v: string): PrivacyVersion | undefined {
  return PRIVACY_VERSIONS.find((p) => p.version === v);
}
