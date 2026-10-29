import { createAuthClient } from "better-auth/react";

// Cliente del navegador: va contra /api/auth del mismo origen, que aplica el límite de intentos.
export const authClient = createAuthClient();
