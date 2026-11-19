import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SETTINGS_KEY, settingsStore, watchTheme } from "./settings";
import Widget from "./widget/Widget";
import "./styles.css";

// Apply the theme before first paint and follow both the preference and the OS setting.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const theme = watchTheme(() => settingsStore.get().theme, document.documentElement, media);
settingsStore.subscribe(theme.refresh);

// The main window and the widget are separate webviews sharing one localStorage: pick up changes
// the other one made.
window.addEventListener("storage", (e) => {
  if (e.key === SETTINGS_KEY) settingsStore.reloadFromStorage();
});

// The edge widget is the same bundle, loaded at `#widget`.
const isWidget = window.location.hash === "#widget";
if (isWidget) document.body.classList.add("widget-body");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isWidget ? <Widget /> : <App />}</React.StrictMode>,
);
