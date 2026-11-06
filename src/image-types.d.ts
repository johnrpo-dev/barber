// Tipos de las imágenes importadas como módulo (import foto from "./foto.jpg"), p. ej. las fotos
// del portal en src/content/portal-photos. Normalmente los trae next-env.d.ts, pero ese archivo lo
// genera Next al correr dev o build y está en .gitignore: en CI el typecheck corre antes del build y
// sin esta línea fallaba con "Cannot find module './…jpg'".
/// <reference types="next/image-types/global" />
