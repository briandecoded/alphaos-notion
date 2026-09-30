// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const pins = [
  { id: "11111111-2222-4333-8444-555555555555", label: "Roadmap", kind: "database", icon: { kind: "emoji", value: "🎲" }, title: "Roadmap", url: "https://www.notion.so/a" },
  { id: "66666666-7777-4888-9999-aaaaaaaaaaaa", label: "Habits", kind: "database", icon: { kind: "emoji", value: "✅" }, title: "Habits", url: "https://www.notion.so/b" },
];

const page = {
  id: "11111111-2222-4333-8444-555555555555",
  kind: "page",
  title: "Roadmap",
  icon: null,
  url: "https://www.notion.so/11111111222243338444555555555555",
  parentTitle: null,
  lastEditedAt: null,
};

describe("notion plugin app", () => {
  it("registers the sidebar page, viewer tab, thread panel tab, and card", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["notion"]);
    expect(app.navPanels[0]!.fixedTabs?.map((tab) => tab.id)).toEqual(["viewer"]);
    expect(app.messageDirectives.map((directive) => directive.id)).toEqual(["notion"]);
    // The card asks openThreadPanel for this exact action id; without the
    // registration every card falls back to the full-page sidebar view.
    expect(app.threadPanelActions.map((action) => action.id)).toEqual(["page"]);
    expect(app.newThreadPanelActions.map((action) => action.id)).toEqual(["page"]);
    expect(app.commandPaletteActions).toEqual([]);
  });

  it("opens a card in the thread side panel, not the full-page view", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { id: page.id, title: "Roadmap" } },
      {
        rpc: { resolve: () => page },
        openThreadPanel: () => true,
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: /open roadmap/i }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openThreadPanel", options: { actionId: "page", title: "Roadmap", params: { id: page.id, title: "Roadmap" } } },
    ]);
    slot.lifecycle.unmount();
  });

  it("falls back to the sidebar page only when the host has no side panel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { id: page.id, title: "Roadmap" } },
      {
        rpc: { resolve: () => page },
        openThreadPanel: () => false,
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: /open roadmap/i }));
    expect(slot.inspection.navigateCalls.map((call) => call.method)).toEqual(["openThreadPanel", "toPluginPanel"]);
    slot.lifecycle.unmount();
  });

  it("lists pinned pages and opens the viewer tab when one is chosen", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          status: () => ({ configured: true, workspace: "Alpha", error: null }),
          pins_list: () => ({ pins }),
          recents_list: () => ({ items: [] }),
        },
        experimental_openFixedTab: () => true,
      },
    );
    await slot.findByText("Roadmap");
    await slot.findByText("Habits");
    fireEvent.click(await slot.findByText("Habits"));
    expect(slot.inspection.experimental_fixedTabOpenCalls).toHaveLength(1);
    expect(slot.inspection.experimental_fixedTabOpenCalls[0]).toMatchObject({ target: { id: pins[1]!.id, title: "Habits" } });
    slot.lifecycle.unmount();
  });
});
