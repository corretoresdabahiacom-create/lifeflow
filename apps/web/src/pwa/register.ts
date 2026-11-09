export const SW_UPDATE_EVENT = "lf:sw-update";

/**
 * Registra o service worker somente em produção. PWA é melhoria progressiva:
 * qualquer falha aqui não pode impedir o uso do app.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        const notify = () => window.dispatchEvent(new CustomEvent(SW_UPDATE_EVENT, { detail: registration }));
        if (registration.waiting && navigator.serviceWorker.controller) notify();
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) notify();
          });
        });
      })
      .catch(() => undefined);
  });
}

/** Ativa a nova versão e recarrega quando o novo service worker assumir o controle. */
export function applyServiceWorkerUpdate(registration: ServiceWorkerRegistration): void {
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
  registration.waiting?.postMessage({ type: "SKIP_WAITING" });
}
