// Renders plugin surfaces with synthetic fixtures through the SDK's test
// runtime, so README screenshots never show private data.
import { createElement as h, Fragment, type ComponentType } from "react";
import { marked } from "marked";
import { icons } from "lucide-react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../../contract";
import { SpecialThreadDialog } from "../../components/special-thread-dialog";
import {
  NOW,
  inboxMessages,
  projectBots,
  projects,
  proseMessage,
  resolvedToday,
  specialThreads,
  threads,
  unaffiliatedBots,
} from "./fixtures";

const scene = new URLSearchParams(location.search).get("scene") ?? "sidebar";
document.documentElement.classList.add(new URLSearchParams(location.search).get("theme") ?? "dark");
document.body.setAttribute("data-bb-plugin-root", "");
document.body.setAttribute("data-bb-plugin", "bb-project-bots");
Date.now = () => NOW + (performance.now() | 0);

// Swap the test runtime's placeholder Markdown/Icon/glyph for real renderings.
function Markdown({ content, className }: { content: string; className?: string }) {
  return h("div", {
    className: `bb-md ${className ?? ""}`,
    dangerouslySetInnerHTML: { __html: marked.parse(content, { async: false }) as string },
  });
}
function Icon({ name, fallback, ...props }: { name: string; fallback?: string; className?: string }) {
  const Cmp = (icons as Record<string, ComponentType<any>>)[name] ?? (fallback ? (icons as any)[fallback] : null);
  return Cmp ? h(Cmp, { ...props, "aria-hidden": true }) : null;
}
function Glyph({ indicator }: { indicator: string }) {
  return h("span", { className: "inline-block size-2 rounded-full bg-amber-400", title: indicator });
}
// loadPluginApp/renderSlot reinstall the runtime, so patch on every install.
let runtimeValue: any;
Object.defineProperty(globalThis, "__bbPluginRuntime", {
  configurable: true,
  get: () => runtimeValue,
  set(next) {
    runtimeValue = next?.pluginSdkApp
      ? { ...next, pluginSdkApp: { ...next.pluginSdkApp, Markdown, experimental_Icon: Icon, experimental_ThreadStatusGlyph: Glyph } }
      : next;
  },
});
installTestPluginRuntime();

const settings = {
  autoSettle: true, autoSettleAfterHours: 72,
  autoArchiveSettled: false, autoArchiveSettledAfterDays: 7,
  autoDeleteArchived: false, autoDeleteArchivedAfterDays: 30,
  autoSettleBots: false, autoSettleBotsAfterHours: 168,
  autoDeleteProjects: false, autoDeleteProjectsAfterDays: 30,
};

const allMessages = [...inboxMessages, ...resolvedToday, proseMessage];
const rpc: Record<string, (input: any) => unknown> = {
  sidebar_state: () => ({
    projectBots,
    unaffiliatedBots,
    hosts: [{ id: "host_studio", name: "studio", connected: true }],
    personalProjectId: "prj_personal",
    threadBindings: [
      { threadId: "thr_cos_week", botId: "bot_chief" },
      { threadId: "thr_cos_sync", botId: "bot_chief" },
    ],
    lastViewed: [],
    lastUsedAt: [],
    pinnedBotIds: ["bot_chief"],
    settledBotIds: [],
    settledThreads: [],
    threadOrder: [{ botId: "projbot_store1", threadIds: ["thr_store_reviewer", "thr_store_lander"] }],
    specialThreads,
    settings,
    dreamConfig: { enabled: true, providerId: "claude-code", model: "sonnet", intervalMinutes: 60 },
    dreamThreadId: null,
    dreamStates: [],
    rootDir: "/demo/.bb/project-bots",
  }),
  conversation_viewed: () => ({ botId: "projbot_store1", materializedNow: false }),
  inbox_list: () => ({ open: inboxMessages, resolvedToday }),
  thread_messages: ({ threadId }) => ({ messages: allMessages.filter((m) => m.threadId === threadId) }),
  get_message: ({ messageId }) => ({ message: allMessages.find((m) => m.id === messageId) ?? null }),
  open_counts_by_thread: () => ({}),
  answer_message: () => ({ ok: true }),
  dismiss_message: () => ({ ok: true }),
  thread_bot_info: () => ({ bot: projectBots[0], tools: [], instructions: "" }),
};

const app = await loadPluginApp(() => import("../../app"));
const common = {
  rpc: rpc as any,
  experimental_rpcContract: rpcContract,
  pluginId: "bb-project-bots",
  sidebarThreads: { status: "ready" as const, threads, projects, sections: [], experimental_archived: null },
  sidebarNavigation: { items: [] },
};

function frame(width: number, child: ReturnType<typeof h>) {
  return h("div", { id: "shot", style: { width }, className: "bg-background text-foreground" }, child);
}

if (scene === "sidebar") {
  const list = app.threadLists[0]!;
  const Sidebar = list.component as ComponentType<any>;
  renderSlot(
    { component: () => frame(320, h("div", { className: "h-[600px] overflow-hidden border-r border-border" }, h(Sidebar, { activeThreadId: "thr_store_checkout", onNavigate() {} }))) },
    {},
    common,
  );
} else if (scene === "inbox") {
  const panel = app.navPanels.find((p) => p.id === "inbox")!;
  const Inbox = panel.component as ComponentType<any>;
  localStorage.clear();
  renderSlot(
    { component: () => frame(900, h("div", { className: "h-[560px] overflow-hidden" }, h(Inbox, { subPath: "" }))) },
    {},
    common,
  );
} else if (scene === "inline") {
  const Directive = app.messageDirectives.find((d) => d.id === "inbox-message")!.component as ComponentType<any>;
  const Bubble = ({ children }: { children: unknown }) =>
    h("div", { className: "ml-auto max-w-[80%] rounded-2xl bg-muted px-4 py-2 text-sm" }, children as any);
  renderSlot(
    {
      component: () =>
        frame(
          760,
          h("div", { className: "flex flex-col gap-4 p-6" }, [
            h(Bubble, { key: "u" }, "Product pages are slow under load. Can we cache them at the CDN?"),
            h(Fragment, { key: "a" }, [
              h("div", { key: "p", className: "text-sm leading-relaxed" }, h(Directive, { attributes: { id: "10" } })),
              h(Directive, { key: "d", attributes: { id: "1" } }),
            ]),
          ]),
        ),
    },
    {},
    common,
  );
} else if (scene === "special") {
  renderSlot(
    {
      component: () =>
        frame(
          720,
          h("div", { className: "h-[760px]" },
            h(SpecialThreadDialog, {
              target: { mode: "promote", threadId: "thr_store_reviewer", botId: "projbot_store1", botName: "acme-storefront", existing: specialThreads[0] },
              onClose() {}, async onCreate() {}, async onSave() {}, async onRemove() {},
            })),
        ),
    },
    {},
    common,
  );
}
document.body.setAttribute("data-ready", "1");
