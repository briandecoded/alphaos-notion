// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const pins = [
  { id: "11111111-2222-4333-8444-555555555555", label: "Roadmap", kind: "database", icon: { kind: "emoji", value: "🎲" }, title: "Roadmap", url: "https://www.notion.so/a" },
  { id: "66666666-7777-4888-9999-aaaaaaaaaaaa", label: "Habits", kind: "database", icon: { kind: "emoji", value: "✅" }, title: "Habits", url: "https://www.notion.so/b" },
];

describe("notion plugin app", () => {
  it("registers the sidebar page, viewer tab, and card — and nothing in the thread panel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["notion"]);
    expect(app.navPanels[0]!.fixedTabs?.map((tab) => tab.id)).toEqual(["viewer"]);
    expect(app.messageDirectives.map((directive) => directive.id)).toEqual(["notion"]);
    // Notion is reference material, not a writing surface: it is deliberately
    // absent from the Cmd+J launcher and from the palette that opened it there.
    expect(app.threadPanelActions).toEqual([]);
    expect(app.newThreadPanelActions).toEqual([]);
    expect(app.commandPaletteActions).toEqual([]);
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
