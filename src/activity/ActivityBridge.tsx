import { useEffect, useRef } from "react";
import { useSettings } from "../settings";
import type { Services } from "../services";
import { broadcastActivity, EVENTS, onEvent, setTrayState, setWidgetVisible } from "./bridge";
import type { ActivitySnapshot } from "./useActivity";

/**
 * Mirrors the activity snapshot to the tray and the edge widget, and carries the widget's quick
 * messages back into the chat. Renders nothing.
 */
export default function ActivityBridge({ snapshot, services }: { snapshot: ActivitySnapshot; services: Services | null }) {
  const [settings] = useSettings();
  const latest = useRef(snapshot);
  latest.current = snapshot;

  // Tray icon: only when the state itself changes.
  useEffect(() => {
    void setTrayState(snapshot);
  }, [snapshot.state]);

  // Widget: every change (the reply text and pending count are shown there too).
  useEffect(() => {
    void broadcastActivity(snapshot);
  }, [snapshot]);

  useEffect(() => {
    void setWidgetVisible(settings.edgeWidget);
  }, [settings.edgeWidget]);

  // A freshly loaded widget asks for the current state.
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void onEvent(EVENTS.widgetReady, () => void broadcastActivity(latest.current)).then((un) => {
      if (cancelled) un();
      else off = un;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // Quick messages from the widget go through the same chat as typed ones.
  useEffect(() => {
    if (!services) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    void onEvent<{ text?: unknown }>(EVENTS.quickSend, (p) => {
      if (typeof p?.text === "string") void services.chat.send(p.text);
    }).then((un) => {
      if (cancelled) un();
      else off = un;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [services]);

  return null;
}
