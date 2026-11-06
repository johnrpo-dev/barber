// Worker en desarrollo local (npm run worker:dev). El worker falla cerrado: sin NODE_ENV se trata
// como producción y, sin las credenciales reales, deja los envíos en pausa. Aquí se fija
// NODE_ENV=development ANTES de cargarlo (por eso el import es dinámico), así los mensajes salen a
// la consola del worker en vez de quedarse en cola. Funciona igual en Windows y en Linux, sin
// depender de la sintaxis VAR=valor de la terminal. Nunca se usa en el VPS.
// NODE_ENV es de solo lectura en los tipos de Next; en tiempo de ejecución es una variable más.
(process.env as Record<string, string | undefined>).NODE_ENV = "development";
await import("../worker/index");

export {};
