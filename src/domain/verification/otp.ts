import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

// Código de verificación de 6 dígitos para la reserva en línea. El código en claro solo existe
// en memoria mientras se envía; se guarda su HMAC con un pepper que vive fuera de la base.
// La base replica estas reglas con un trigger (migración public_booking_guards).

export const OTP_LENGTH = 6;
export const OTP_TTL_MIN = 5;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SEC = 60;
/** Envíos por retención: el primero y dos reenvíos. */
export const OTP_MAX_SENDS = 3;

/** 6 dígitos uniformes (randomInt evita el sesgo del módulo). */
export function generateOtp(random: (max: number) => number = randomInt): string {
  return String(random(10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

/** HMAC-SHA256 ligado a la verificación: el mismo código en otra verificación da otro hash. */
export function hashOtp(pepper: string, verificationId: bigint, code: string): Buffer {
  return createHmac("sha256", pepper).update(`otp:${verificationId}:${code}`).digest();
}

/** Lo que escribió la persona, sin espacios ni guiones ("123 456" → "123456"); null si no son 6 dígitos. */
export function normalizeOtpInput(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  return digits.length === OTP_LENGTH ? digits : null;
}

export function otpMatches(pepper: string, verificationId: bigint, code: string, storedHash: Uint8Array): boolean {
  const candidate = hashOtp(pepper, verificationId, code);
  return storedHash.length === candidate.length && timingSafeEqual(candidate, storedHash);
}

/** Vence a los 5 minutos, o antes si vence la retención del horario. */
export function otpExpiry(now: Date, holdExpiresAt: Date): Date {
  return new Date(Math.min(now.getTime() + OTP_TTL_MIN * 60_000, holdExpiresAt.getTime()));
}

export interface OtpState {
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  supersededAt: Date | null;
}

export type OtpOutcome = "verified" | "wrong" | "expired" | "locked" | "used" | "superseded";

/**
 * Un intento. El intento se cuenta ANTES de comparar (la base hace lo mismo con un UPDATE
 * condicionado), así que adivinar cuesta un intento aunque falle.
 */
export function applyOtpAttempt(state: OtpState, matches: boolean, now: Date): { state: OtpState; outcome: OtpOutcome } {
  if (state.consumedAt) return { state, outcome: "used" };
  if (state.supersededAt) return { state, outcome: "superseded" };
  if (now.getTime() >= state.expiresAt.getTime()) return { state, outcome: "expired" };
  if (state.attempts >= state.maxAttempts) return { state, outcome: "locked" };
  const counted = { ...state, attempts: state.attempts + 1 };
  if (!matches) return { state: counted, outcome: "wrong" };
  return { state: { ...counted, consumedAt: now }, outcome: "verified" };
}

export type ResendDecision = { ok: true } | { ok: false; reason: "cooldown"; waitSec: number } | { ok: false; reason: "limit" };

export function canResendOtp(input: { sendCount: number; lastSentAt: Date }, now: Date): ResendDecision {
  if (input.sendCount >= OTP_MAX_SENDS) return { ok: false, reason: "limit" };
  const elapsedSec = Math.floor((now.getTime() - input.lastSentAt.getTime()) / 1000);
  if (elapsedSec < OTP_RESEND_COOLDOWN_SEC) return { ok: false, reason: "cooldown", waitSec: OTP_RESEND_COOLDOWN_SEC - elapsedSec };
  return { ok: true };
}
