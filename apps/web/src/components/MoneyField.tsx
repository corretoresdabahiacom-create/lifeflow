import { parseMoneyToCents } from "@lifeflow/shared";

/** Campo de valor em reais: o texto digitado vira centavos inteiros (nunca decimal) antes de ir à API. */
export function MoneyField({
  label,
  value,
  onChange,
  allowNegative = false,
  required = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  allowNegative?: boolean;
  required?: boolean;
}) {
  const cents = value.trim() === "" ? null : parseMoneyToCents(value);
  const invalid = value.trim() !== "" && (cents === null || (!allowNegative && cents < 0));
  return (
    <label className="field">
      <span>{label}</span>
      <input
        inputMode="decimal"
        autoComplete="off"
        placeholder="0,00"
        value={value}
        required={required}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
      />
      {invalid ? <small className="form-error">Valor inválido. Exemplo: 1.234,56</small> : null}
    </label>
  );
}

/** Converte o texto do campo em centavos positivos, ou `null` se inválido/zero. */
export function toPositiveCents(value: string): number | null {
  const cents = parseMoneyToCents(value);
  return cents !== null && cents > 0 ? cents : null;
}
