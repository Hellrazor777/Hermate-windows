import { useEffect, useRef } from "react";
import { createDeliverer } from "../notifications/deliver";
import { Notifier } from "../notifications/notifier";
import { useSettings } from "../settings";
import type { Services } from "../services";
import { broadcastActivity, EVENTS, onEvent, setTrayState, setWidgetVisible } from "./bridge";
import type { ActivitySnapshot } from "./useActivity";

/**
 * Mirrors the activity snapshot to the tray and the edge widget, carries the widget's quick
 * messages back into the chat, and raises desktop notifications. Renders nothing.
 */
export default function ActivityBridge({ snapshot, services }: { snapshot: ActivitySnapshot; services: Services | null }) {
  const [settings] = useSettings();
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const notifier = useRef(new Notifier());
  const deliver = useRef(createDeliverer());

  // Tray icon: only when the state itself changes.
  useEffect(() => {
    void setTrayState(snapshot);
  }, [snapshot.state]);

  // Widget: every change (the reply text and pending count are shown there too).
  useEffect(() => {
    void broadcastActivity(snapshot);
  }, [snapshot]);

  // Desktop notifications: a request that needs an answer, or a finished reply, while the window is not in front.
  useEffect(() => {
    const notices = notifier.current.observe({
      state: snapshot.state,
      pendingIds: services?.inbox.get().pending.map((p) => p.id) ?? [],
      focused: document.hasFocus(),
      enabled: settings.notifications,
    });
    void deliver.current(notices);
  }, [snapshot, services, settings.notifications]);

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
