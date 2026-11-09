import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "../auth/context";
import { createApiClient, type ApiClient } from "../lib/api";
import { apiBaseUrl } from "../lib/firebase";

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ children, client }: { children: ReactNode; client?: ApiClient }) {
  const { getIdToken } = useAuth();
  const value = useMemo(
    () => client ?? createApiClient({ baseUrl: apiBaseUrl, getToken: getIdToken }),
    [client, getIdToken],
  );
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const value = useContext(ApiContext);
  if (!value) throw new Error("useApi precisa estar dentro de <ApiProvider>");
  return value;
}
