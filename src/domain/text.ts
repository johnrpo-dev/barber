// Saneador común del texto libre (nombres, notas, motivos, descripciones). Cierra el hallazgo B-4 de la
// auditoría del sprint 6: la base solo excluye `[[:cntrl:]]`, y los controles bidi (U+202E, que da
// vuelta el texto) o los invisibles de ancho cero (U+200B) pasaban. React los escapa (no hay XSS),
// pero confunden a la vista en la bitácora y en las listas, y parten un mismo nombre en dos.
//
// Todo texto libre de Villa es de una línea (ninguna pantalla muestra saltos de línea), así que:
// - los controles (C0, C1), los saltos y todo espacio Unicode se vuelven un solo espacio;
// - los invisibles de formato (\p{Cf}: bidi, ancho cero, guion suave, BOM) y los rellenos de Hangul
//   (U+3164 y similares, que pasan por un nombre "en blanco") se quitan;
// - el unidor de ancho cero (U+200D) se conserva solo entre dos emojis (👨\u200D💻), donde arma uno solo;
// - queda recortado y en NFC: "José" con la tilde aparte y con la letra acentuada es lo mismo.
// Es idempotente: limpiar dos veces da lo mismo que una (lo comprueba una prueba de propiedades).

const ZWJ = /\u200D/g;
/** Invisibles que se quitan; el U+200D se decide aparte, según lo que lo rodea. */
const INVISIBLE = /(?!\u200D)[\p{Cf}\u115F\u1160\u3164\uFFA0]/gu;
const SPACES = /[\p{Cc}\p{Z}\s]+/gu;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;

/** Tono de piel (U+1F3FB a U+1F3FF) o selector de variante (U+FE0F): van entre el emoji y el unidor. */
export function isEmojiTail(cp: number): boolean {
  return (cp >= 0x1f3fb && cp <= 0x1f3ff) || cp === 0xfe0f;
}

function isPictograph(cp: number | undefined): boolean {
  return cp !== undefined && PICTOGRAPH.test(String.fromCodePoint(cp));
}

// Se mira por puntos de c\u00F3digo y no con una sola expresi\u00F3n: en V8 (Node 26),
// /\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?$/u no reconoce "\uD83D\uDC68\uD83C\uDFFD" (la clase opcional de astrales y el $).
function keepsZwj(text: string, at: number): boolean {
  const before = [...text.slice(Math.max(0, at - 4), at)].map((ch) => ch.codePointAt(0)!);
  let prev = before.pop();
  if (prev !== undefined && isEmojiTail(prev)) prev = before.pop();
  return isPictograph(prev) && isPictograph(text.codePointAt(at + 1));
}

/** Texto libre de una línea, limpio. Puede quedar vacío: la longitud mínima la exige quien lo usa. */
export function cleanText(input: string): string {
  return input
    .replace(ZWJ, (zwj, at: number, all: string) => (keepsZwj(all, at) ? zwj : ""))
    .replace(INVISIBLE, "")
    .replace(SPACES, " ")
    .trim()
    .normalize("NFC");
}
