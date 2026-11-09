/**
 * Dinheiro sempre em CENTAVOS INTEIROS. Nenhum valor monetário é guardado ou somado como
 * número decimal (evita erros de ponto flutuante como 0,1 + 0,2).
 */

/** Teto de segurança por valor: R$ 1 bilhão em centavos (bem abaixo de Number.MAX_SAFE_INTEGER). */
export const MAX_CENTS = 100_000_000_000;

/**
 * Converte texto digitado ("1.234,56", "12,5", "R$ 10", "1234.56", "-5,00") em centavos.
 * Retorna `null` para qualquer entrada ambígua ou inválida. A vírgula é sempre decimal; o ponto
 * é milhar quando forma grupos de três dígitos e decimal quando tem 1 ou 2 casas.
 */
export function parseMoneyToCents(input: string): number | null {
  let text = input.trim().replace(/^(-?)\s*R\$\s*/i, "$1").replace(/\s+/g, "");
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  if (text === "") return null;

  let integerPart: string;
  let fraction = "";
  if (text.includes(",")) {
    const pieces = text.split(",");
    if (pieces.length !== 2) return null;
    const [whole = "", frac = ""] = pieces;
    if (!/^\d{1,3}(\.\d{3})+$|^\d+$/.test(whole)) return null;
    if (!/^\d{1,2}$/.test(frac)) return null;
    integerPart = whole.replace(/\./g, "");
    fraction = frac;
  } else if (text.includes(".")) {
    if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
      integerPart = text.replace(/\./g, "");
    } else if (/^\d+\.\d{1,2}$/.test(text)) {
      const [whole = "", frac = ""] = text.split(".");
      integerPart = whole;
      fraction = frac;
    } else {
      return null;
    }
  } else {
    if (!/^\d+$/.test(text)) return null;
    integerPart = text;
  }

  if (integerPart.length > 12) return null;
  const cents = Number(integerPart) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  return negative ? -cents : cents;
}

/** Texto para exibição, ex.: `R$ 1.234,56`. Só para a interface; nunca usar o resultado em cálculos. */
export function formatCents(cents: number, currency = "BRL", locale = "pt-BR"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

/** Decimal com ponto, sem arredondamento de ponto flutuante: `-1234` → `"-12.34"`. Usado na exportação. */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
