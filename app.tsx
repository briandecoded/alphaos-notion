// bb-plugin-notion — frontend entry. Registers:
// - a "Notion" sidebar page whose right pane is the native viewer,
// - a "Notion" tab in the thread right panel (and on the New-thread screen),
// - the ::notion{} message card.
//
// The card opens the page in the thread's right panel so the conversation stays
// in place; the sidebar page is the fallback only where no side panel exists
// (a ThreadChat embedded in another plugin's panel). Without the panel action
// below, openThreadPanel is always declined and every card lands on the
// full-page view, which is exactly what a reader mid-conversation does not want.
//
// Deliberately NOT a message action: opening a page beside a thread is not
// something you want from one particular reply, so it does not earn a slot in
// every message's action bar.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { NotionCard, NotionHome, NotionNewThreadPanel, NotionThreadPanel, NotionViewerTab, NAV_PATH, THREAD_ACTION_ID } from "./views/surfaces";
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

  // "Notion" in a thread's right-panel Actions list (next to Start side chat /
  // Start terminal): chat on the left, the page on the right. The same action
  // id is what NotionCard asks openThreadPanel for, so cards land here.
  app.slots.threadPanelAction({
    id: THREAD_ACTION_ID,
    title: "Notion",
    layout: "flush",
    component: NotionThreadPanel,
  });

  // Same tab on the root New thread screen. Experimental slot: guarded so a
  // future bb without it still loads the rest.
  try {
    app.slots.experimental_newThreadPanelAction({
      id: THREAD_ACTION_ID,
      title: "Notion",
      layout: "flush",
      component: NotionNewThreadPanel,
    });
  } catch (error) {
    console.warn("[notion] new-thread panel action slot unavailable", error);
  }

  app.slots.messageDirective({ id: "notion", component: NotionCard });
});
