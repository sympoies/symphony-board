import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { isTauriRuntime, normalizeDesktopStartupRoute, openExternalUrl } from "./runtime.ts";
import "./styles.css";

normalizeDesktopStartupRoute();

document.addEventListener(
  "click",
  (event) => {
    if (!isTauriRuntime() || event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!(target instanceof HTMLAnchorElement)) return;
    if (!/^https?:\/\//i.test(target.href)) return;
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
