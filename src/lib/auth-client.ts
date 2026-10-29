import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Cliente del navegador: va contra /api/auth del mismo origen, que aplica el límite de intentos
// y el bloqueo por cuenta. Con la verificación en dos pasos, signIn.email devuelve
// { twoFactorRedirect: true } y el formulario pide el código (sin redirección automática).
export const authClient = createAuthClient({ plugins: [twoFactorClient()] });
