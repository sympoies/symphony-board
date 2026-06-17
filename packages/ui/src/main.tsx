import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import {
  installAndroidSafeAreaInsets,
  internalRouteHashFromHref,
  isTauriRuntime,
  normalizeDesktopStartupRoute,
  openExternalUrl,
  shouldOpenExternalHttpHref,
} from "./runtime.ts";
import "./styles.css";

normalizeDesktopStartupRoute();
installAndroidSafeAreaInsets();

document.addEventListener(
  "click",
  (event) => {
    if (!isTauriRuntime() || event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!(target instanceof HTMLAnchorElement)) return;

    const internalHash = internalRouteHashFromHref(target.getAttribute("href"), target.href, window.location.href);
    if (internalHash) {
      event.preventDefault();
      if (window.location.hash !== internalHash) window.location.hash = internalHash;
      return;
    }

    if (!shouldOpenExternalHttpHref(target.getAttribute("href"), target.href, window.location.href)) return;
    event.preventDefault();
    void openExternalUrl(target.href);
  },
  true,
);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
