import "./styles.css";
import { setNonce } from "get-nonce";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "@fontsource-variable/inter";
import "@fontsource-variable/atkinson-hyperlegible-mono";

const styleNonce = document.querySelector<HTMLMetaElement>(
  'meta[name="style-nonce"]',
)?.content;
if (styleNonce) setNonce(styleNonce);

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
