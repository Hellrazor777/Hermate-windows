import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { settingsStore, watchTheme } from "./settings";
import "./styles.css";

// Apply the theme before first paint and follow both the preference and the OS setting.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const theme = watchTheme(() => settingsStore.get().theme, document.documentElement, media);
settingsStore.subscribe(theme.refresh);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
