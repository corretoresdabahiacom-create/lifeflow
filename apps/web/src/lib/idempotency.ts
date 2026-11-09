import { useCallback, useRef } from "react";

export const newIdempotencyKey = (): string => `web-${crypto.randomUUID()}`;

/**
 * Chave de idempotência de UMA ação do usuário (ex.: um envio de formulário).
 * Fica a mesma enquanto a ação não for concluída, então reenviar após erro de rede ou timeout nunca
 * duplica o lançamento. Chame `renew()` quando a ação terminar com sucesso ou o conteúdo mudar.
 */
export function useIdempotencyKey(): { current: () => string; renew: () => void } {
  const ref = useRef(newIdempotencyKey());
  const current = useCallback(() => ref.current, []);
  const renew = useCallback(() => {
    ref.current = newIdempotencyKey();
  }, []);
  return { current, renew };
}
