import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const env = import.meta.env;

/**
 * URL e chave PUBLICÁVEL do projeto Supabase são identificadores públicos (não segredos): a segurança dos dados vem
 * da RLS do Postgres e da validação do JWT no Worker. A chave secreta (`sb_secret_…`) NUNCA vai ao navegador.
 */
const url = env.VITE_SUPABASE_URL ?? "";
const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

export const isSupabaseConfigured = Boolean(url && publishableKey);

let client: SupabaseClient | null = null;

/** O front só fala com o Supabase para AUTENTICAR; todos os dados passam pelo Worker (`apiBaseUrl`). */
export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  client ??= createClient(url, publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export const apiBaseUrl = (env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
