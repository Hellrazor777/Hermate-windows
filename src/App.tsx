import { useState } from "react";
import ChatView from "./chat/ChatView";
import ConnectionScreen from "./connection/ConnectionScreen";
import ActivityBridge from "./activity/ActivityBridge";
import { useActivity } from "./activity/useActivity";
import RequestsPanel from "./requests/RequestsPanel";
import type { HermesClient } from "./rpc";
import { useServices } from "./services";
import TerminalPane from "./terminal/TerminalPane";
import { THEME_PREFERENCES, settingsStore, useSettings, type ThemePreference } from "./settings";

const THEME_LABELS: Record<ThemePreference, string> = { system: "Match system", light: "Light", dark: "Dark" };

export default function App() {
  const [settings, update] = useSettings();
  const [client, setClient] = useState<HermesClient | null>(null);
  const services = useServices(client);
  const activity = useActivity(client, services);
  return (
    <main>
      <ActivityBridge snapshot={activity} services={services} />
      <h1>Hermate</h1>
      <p className="muted">
        Unofficial Windows companion for Hermes Agent. {client ? "Connected." : "Not connected."}
      </p>

      {services && <RequestsPanel inbox={services.inbox} />}
      <ConnectionScreen onConnected={setClient} />
      {services && <ChatView chat={services.chat} />}

      <TerminalPane />

      <fieldset>
        <legend>Appearance</legend>
        {THEME_PREFERENCES.map((t) => (
          <label key={t}>
            <input type="radio" name="theme" checked={settings.theme === t} onChange={() => update({ theme: t })} />{" "}
            {THEME_LABELS[t]}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Behaviour</legend>
        <label>
          <input
            type="checkbox"
            checked={settings.notifications}
            onChange={(e) => update({ notifications: e.target.checked })}
          />{" "}
          Notifications for approvals and finished turns
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.edgeWidget}
            onChange={(e) => update({ edgeWidget: e.target.checked })}
          />{" "}
          Edge widget
        </label>
      </fieldset>

      <button onClick={() => settingsStore.reset()}>Reset to defaults</button>
    </main>
  );
}
