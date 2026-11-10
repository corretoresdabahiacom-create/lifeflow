import type { Account, Category } from "@lifeflow/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";

const api = {
  createTransaction: vi.fn(),
  createTransfer: vi.fn(),
};

vi.mock("../../app/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../../app/ProfileProvider", () => ({
  useProfile: () => ({ profile: { currency: "BRL", locale: "pt-BR", displayName: "Ana" } }),
}));

import { TransactionForm, TransferForm } from "./TransactionsPage";

const account = (id: string, name: string): Account => ({
  id, uid: "u", name, type: "checking", initialBalanceCents: 0, balanceCents: 0, archived: false, createdAt: "", updatedAt: "",
});
const accounts = [account("a1", "Corrente"), account("a2", "Poupança")];
const categories: Category[] = [
  { id: "c1", uid: "u", name: "Mercado", kind: "expense", archived: false, createdAt: "", updatedAt: "" },
  { id: "c2", uid: "u", name: "Salário", kind: "income", archived: false, createdAt: "", updatedAt: "" },
];

const fill = (amount: string, description = "Mercado") => {
  fireEvent.change(screen.getByLabelText("Valor"), { target: { value: amount } });
  fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: description } });
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Registrar" }));

beforeEach(() => {
  api.createTransaction.mockReset();
  api.createTransfer.mockReset();
});
afterEach(cleanup);

describe("TransactionForm", () => {
  it("converte o valor digitado em centavos inteiros e envia Idempotency-Key", async () => {
    api.createTransaction.mockResolvedValue({});
    render(<TransactionForm accounts={accounts} categories={categories} onDone={() => undefined} />);
    fill("1.234,56");
    submit();
    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(1));
    const [body, key] = api.createTransaction.mock.calls[0] as [Record<string, unknown>, string];
    expect(body).toMatchObject({ accountId: "a1", type: "expense", amountCents: 123456, description: "Mercado", allowDuplicate: false });
    expect(Number.isInteger(body["amountCents"])).toBe(true);
    expect(key).toMatch(/^web-/);
  });

  it("não envia valor inválido", () => {
    render(<TransactionForm accounts={accounts} categories={categories} onDone={() => undefined} />);
    fill("abc");
    submit();
    expect(api.createTransaction).not.toHaveBeenCalled();
    expect(screen.getAllByText(/valor/i).length).toBeGreaterThan(0);
  });

  it("após erro de rede, reenviar usa a MESMA chave; após sucesso, a próxima ação usa chave nova", async () => {
    api.createTransaction
      .mockRejectedValueOnce(new TypeError("falha de rede"))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    render(<TransactionForm accounts={accounts} categories={categories} onDone={() => undefined} />);
    fill("10,00");
    submit();
    await screen.findByRole("alert");
    submit(); // tentativa 2 da mesma ação
    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(2));
    await screen.findByText("Lançamento registrado.");
    fill("20,00", "Outro");
    submit(); // outra ação
    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(3));

    const keys = api.createTransaction.mock.calls.map((c) => (c as [unknown, string])[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("duplicidade provável pede confirmação e reenvia com allowDuplicate e chave nova", async () => {
    api.createTransaction
      .mockRejectedValueOnce(new ApiError(409, "possible_duplicate", "Já existe um lançamento igual"))
      .mockResolvedValueOnce({});
    render(<TransactionForm accounts={accounts} categories={categories} onDone={() => undefined} />);
    fill("10,00");
    submit();
    await screen.findByText("Já existe um lançamento igual");
    fireEvent.click(screen.getByRole("button", { name: "Registrar mesmo assim" }));
    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(2));
    const [first, second] = api.createTransaction.mock.calls as Array<[Record<string, unknown>, string]>;
    expect(first?.[0]["allowDuplicate"]).toBe(false);
    expect(second?.[0]["allowDuplicate"]).toBe(true);
    expect(second?.[1]).not.toBe(first?.[1]);
  });

  it("só oferece categorias do tipo escolhido", () => {
    render(<TransactionForm accounts={accounts} categories={categories} onDone={() => undefined} />);
    expect(screen.queryByRole("option", { name: "Salário" })).toBeNull();
    expect(screen.getByRole("option", { name: "Mercado" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Receita" }));
    expect(screen.getByRole("option", { name: "Salário" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Mercado" })).toBeNull();
  });
});

describe("TransferForm", () => {
  it("bloqueia origem igual ao destino e envia centavos com chave", async () => {
    api.createTransfer.mockResolvedValue({});
    render(<TransferForm accounts={accounts} onDone={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Valor"), { target: { value: "300,00" } });
    fireEvent.change(screen.getByLabelText("Para"), { target: { value: "a1" } });
    fireEvent.click(screen.getByRole("button", { name: "Transferir" }));
    expect(api.createTransfer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Para"), { target: { value: "a2" } });
    fireEvent.click(screen.getByRole("button", { name: "Transferir" }));
    await waitFor(() => expect(api.createTransfer).toHaveBeenCalledTimes(1));
    const [body, key] = api.createTransfer.mock.calls[0] as [Record<string, unknown>, string];
    expect(body).toMatchObject({ fromAccountId: "a1", toAccountId: "a2", amountCents: 30000 });
    expect(key).toMatch(/^web-/);
  });
});
