const MESSAGES: Record<string, string> = {
  "auth/invalid-email": "E-mail inválido.",
  "auth/missing-password": "Informe a senha.",
  "auth/weak-password": "Senha fraca: use pelo menos 8 caracteres.",
  "auth/email-already-in-use": "Este e-mail já está cadastrado.",
  "auth/user-not-found": "E-mail ou senha incorretos.",
  "auth/wrong-password": "E-mail ou senha incorretos.",
  "auth/invalid-credential": "E-mail ou senha incorretos.",
  "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
  "auth/network-request-failed": "Sem conexão. Verifique a internet e tente novamente.",
  "auth/user-disabled": "Esta conta está desativada.",
};

/** Traduz erros do Firebase Auth sem expor detalhes internos. */
export function authErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  return MESSAGES[code] ?? "Não foi possível concluir a operação. Tente novamente.";
}

export const MIN_PASSWORD_LENGTH = 8;
