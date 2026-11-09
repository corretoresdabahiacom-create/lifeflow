import { formatCents } from "@lifeflow/shared";
import { useProfile } from "../app/ProfileProvider";

/** Formata centavos na moeda e no idioma do perfil. */
export function useMoney(): (cents: number) => string {
  const { profile } = useProfile();
  const currency = profile?.currency ?? "BRL";
  const locale = profile?.locale ?? "pt-BR";
  return (cents) => formatCents(cents, currency, locale);
}

export const todayLocal = (): string => new Date().toLocaleDateString("en-CA");

export const monthRange = (reference = new Date()): { from: string; to: string } => {
  const y = reference.getFullYear();
  const m = reference.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = new Date(y, m + 1, 0).getDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` };
};

export const formatDate = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
};
