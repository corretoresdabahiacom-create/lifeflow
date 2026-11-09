import { z } from "zod";

/**
 * Schemas de entrada da API. Todos são `strict`: campos desconhecidos (incluindo `uid`)
 * são rejeitados, para que o cliente nunca possa informar a identidade.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use o formato HH:MM");

export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

export const ProfileInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "Locale inválido, ex.: pt-BR"),
    timezone: z.string().min(1).max(64),
    currency: z.string().regex(/^[A-Z]{3}$/, "Moeda ISO 4217, ex.: BRL"),
  })
  .strict();
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export const PreferencesInputSchema = z
  .object({
    theme: z.enum(THEMES),
    confirmCreations: z.boolean(),
    quietHoursStart: hhmm,
    quietHoursEnd: hhmm,
  })
  .strict();
export type PreferencesInput = z.infer<typeof PreferencesInputSchema>;

export interface Profile extends ProfileInput {
  uid: string;
  createdAt: string;
  updatedAt: string;
}

export interface Preferences extends PreferencesInput {
  uid: string;
  updatedAt: string;
}

export const DEFAULT_PREFERENCES: PreferencesInput = {
  theme: "system",
  confirmCreations: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
};
