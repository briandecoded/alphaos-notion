// bb-plugin-notion — frontend entry. Registers:
// - a "Notion" sidebar page whose right pane is the native viewer,
// - the ::notion{} message card.
//
// Deliberately NOT in the thread right panel: the Cmd+J launcher is reserved
// for what you write and run beside a conversation, and Notion is neither —
// it is reference material, so it lives on its own sidebar page. The ::notion{}
// card opens there too: it asks for a side panel first and falls back to the
// page when the host declines, which is now always.
//
// Deliberately NOT a message action either: opening a page beside a thread is
// not something you want from one particular reply, so it does not earn a slot
// in every message's action bar.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { NotionCard, NotionHome, NotionViewerTab, NAV_PATH } from "./views/surfaces";
import { VIEWER_TAB } from "./views/shared";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: VIEWER_TAB.panelId,
    title: "Notion",
    icon: "./assets/notion.svg",
    path: NAV_PATH,
    component: NotionHome,
    fixedTabs: [
      {
        ...VIEWER_TAB,
        title: "Viewer",
        icon: "FileText",
        layout: "flush",
        component: NotionViewerTab,
      },
    ],
  });

  app.slots.messageDirective({ id: "notion", component: NotionCard });
});
