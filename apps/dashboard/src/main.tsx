import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyThemeFromStorage } from "./lib/theme";
import "./index.css";

applyThemeFromStorage();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
