import type { ProfileInput } from "@lifeflow/shared";

export function normalizeLocale(raw: string | undefined): string {
  if (!raw) return "pt-BR";
  const [lang, region] = raw.split("-");
  if (!lang || !/^[a-zA-Z]{2}$/.test(lang)) return "pt-BR";
  const language = lang.toLowerCase();
  if (region && /^[a-zA-Z]{2}$/.test(region)) return `${language}-${region.toUpperCase()}`;
  return language;
}

export function defaultProfileFor(
  email: string | null | undefined,
  browserLocale?: string,
  timeZone?: string,
): ProfileInput {
  const local = (email ?? "").split("@")[0]?.trim() ?? "";
  return {
    displayName: (local || "Usuário").slice(0, 80),
    locale: normalizeLocale(browserLocale),
    timezone: timeZone && timeZone.length <= 64 ? timeZone : "America/Sao_Paulo",
    currency: "BRL",
  };
}
