import { useEffect, useState } from "react";
import { ChatController } from "./chat/controller";
import { CronStore } from "./cron/store";
import { FilesStore } from "./files/store";
import { KanbanStore } from "./kanban/store";
import { RequestInbox } from "./requests/inbox";
import type { HermesClient } from "./rpc";
import { UsageStore } from "./usage/store";
import { SessionList } from "./sessions/list";

/** Everything that lives for the length of one Hermes connection. */
export interface Services {
  chat: ChatController;
  inbox: RequestInbox;
  cron: CronStore;
  usage: UsageStore;
  files: FilesStore;
  kanban: KanbanStore;
  sessions: SessionList;
}

/**
 * Create the per-connection services in an effect (not during render) so each mount owns its
 * own instances: React StrictMode runs cleanup and setup again in development, and a service that
 * was disposed by the simulated unmount must never be reused.
 */
export function useServices(client: HermesClient | null): Services | null {
  const [services, setServices] = useState<Services | null>(null);
  useEffect(() => {
    if (!client) {
      setServices(null);
      return;
    }
    const s: Services = { chat: new ChatController(client), inbox: new RequestInbox(client), cron: new CronStore(client), usage: new UsageStore(client), files: new FilesStore(client), kanban: new KanbanStore(client), sessions: new SessionList(client) };
    setServices(s);
    return () => {
      void s.chat.close();
      s.inbox.dispose();
      s.cron.dispose();
      s.usage.dispose();
      s.files.dispose();
      s.kanban.dispose();
      s.sessions.dispose();
    };
  }, [client]);
  return services;
}
