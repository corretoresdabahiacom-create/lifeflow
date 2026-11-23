const MESSAGES: Record<string, string> = {
  validation_failed: "E-mail ou senha inválidos.",
  email_address_invalid: "E-mail inválido.",
  weak_password: "Senha fraca: use pelo menos 8 caracteres.",
  user_already_exists: "Este e-mail já está cadastrado.",
  email_exists: "Este e-mail já está cadastrado.",
  // Não diferencia "usuário inexistente" de "senha errada" (não revela quais e-mails têm conta).
  invalid_credentials: "E-mail ou senha incorretos.",
  email_not_confirmed: "Confirme seu e-mail pelo link que enviamos antes de entrar.",
  email_confirmation_required: "Conta criada! Enviamos um link de confirmação para o seu e-mail; confirme e depois entre.",
  over_request_rate_limit: "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
  over_email_send_rate_limit: "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
  user_banned: "Esta conta está desativada.",
  signup_disabled: "O cadastro de novas contas está desativado.",
};

/** Traduz erros do Supabase Auth sem expor detalhes internos. */
export function authErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { code, name, status } = error as { code?: unknown; name?: unknown; status?: unknown };
    if (typeof code === "string" && MESSAGES[code]) return MESSAGES[code] as string;
    // Falha de rede do SDK (sem resposta do servidor).
    if (name === "AuthRetryableFetchError" || status === 0) return "Sem conexão. Verifique a internet e tente novamente.";
    if (status === 429) return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}

export const MIN_PASSWORD_LENGTH = 8;
