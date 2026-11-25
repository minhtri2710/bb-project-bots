// Synthetic data for README screenshots. Never put real bots, projects,
// machines, conversations, or memory in here.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { BotRecordDto, InboxMessage, SpecialThreadDto } from "../../contract";

export const NOW = Date.UTC(2026, 10, 24, 17, 0, 0);
const min = 60_000;
const hour = 60 * min;

function bot(partial: Partial<BotRecordDto> & Pick<BotRecordDto, "id" | "kind" | "name">): BotRecordDto {
  return {
    role: partial.kind === "project" ? "Project Bot" : "Coordinator",
    avatar: { color: "#6C8CFF", shape: "round", expression: "curious", motion: "calm" },
    soul: "",
    memory: "",
    filePath: `/demo/.bb/project-bots/${partial.id}.md`,
    materialized: true,
    createdAt: NOW - 30 * 24 * hour,
    updatedAt: NOW - hour,
    ...partial,
  };
}

export const projects = [
  { id: "prj_storefront", name: "acme-storefront", isPersonal: false, href: "#", settingsHref: "#" },
  { id: "prj_atlas", name: "atlas-api", isPersonal: false, href: "#", settingsHref: "#" },
  { id: "prj_garden", name: "pixel-garden", isPersonal: false, href: "#", settingsHref: "#" },
  { id: "prj_personal", name: "Personal", isPersonal: true, href: "#", settingsHref: "#" },
];

export const projectBots: BotRecordDto[] = [
  bot({
    id: "projbot_store1", kind: "project", name: "acme-storefront",
    avatar: { color: "#FF7A59", shape: "blob", expression: "happy", motion: "playful" },
    projectId: "prj_storefront", projectPath: "/home/demo/src/acme-storefront", projectHostId: "host_studio",
  }),
  bot({
    id: "projbot_atlas1", kind: "project", name: "atlas-api",
    avatar: { color: "#2EC4B6", shape: "squircle", expression: "focused", motion: "calm" },
    projectId: "prj_atlas", projectPath: "/home/demo/src/atlas-api", projectHostId: "host_studio",
  }),
  bot({
    id: "projbot_garden", kind: "project", name: "pixel-garden",
    avatar: { color: "#B388FF", shape: "cloud", expression: "sleepy", motion: "calm" },
    projectId: "prj_garden", projectPath: "/home/demo/src/pixel-garden", projectHostId: "host_studio",
  }),
];

export const unaffiliatedBots: BotRecordDto[] = [
  bot({
    id: "bot_chief", kind: "unaffiliated", name: "Chief of Staff", role: "Coordinates across projects",
    avatar: { color: "#FFC145", shape: "hexagon", expression: "proud", motion: "calm" },
    directoryPath: "/demo/.bb/project-bots/unaffiliated/bot_chief",
  }),
];

function thread(p: Partial<PluginSidebarThread> & Pick<PluginSidebarThread, "id" | "projectId" | "title">): PluginSidebarThread {
  return {
    titleFallback: null,
    displayTitle: p.title ?? p.id,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    parentNotifications: "auto",
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "claude-code",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: "#",
    isHidden: false,
    environment: null,
    host: { id: "host_studio", name: "studio" },
    createdAt: NOW - 2 * hour,
    updatedAt: NOW - hour,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...p,
  } as PluginSidebarThread;
}

export const threads: PluginSidebarThread[] = [
  // Chief of Staff (bound threads)
  thread({ id: "thr_cos_week", projectId: "prj_personal", title: "Weekly launch checklist", updatedAt: NOW - 5 * min, status: "active", runtimeStatus: "active", indicator: "runtime" }),
  thread({ id: "thr_cos_sync", projectId: "prj_personal", title: "Sync storefront + API release dates", updatedAt: NOW - 3 * hour, indicator: "unread-success", isUnread: true }),

  // acme-storefront
  thread({ id: "thr_store_reviewer", projectId: "prj_storefront", title: "Reviewer", updatedAt: NOW - 20 * min, createdAt: NOW - 5 * 24 * hour }),
  thread({ id: "thr_store_lander", projectId: "prj_storefront", title: "Lander", updatedAt: NOW - 50 * min, createdAt: NOW - 5 * 24 * hour }),
  thread({ id: "thr_store_checkout", projectId: "prj_storefront", title: "Checkout: Apple Pay button", updatedAt: NOW - 2 * min, status: "active", runtimeStatus: "active", indicator: "runtime" }),
  thread({ id: "thr_store_checkout_sub", projectId: "prj_storefront", title: "Write Playwright smoke test", parentThreadId: "thr_store_checkout", updatedAt: NOW - 4 * min, status: "active", runtimeStatus: "active", indicator: "runtime" }),
  thread({ id: "thr_store_cache", projectId: "prj_storefront", title: "Pick a CDN cache strategy", updatedAt: NOW - 12 * min, hasPendingInteraction: true, indicator: "waiting-for-input" }),
  thread({ id: "thr_store_a11y", projectId: "prj_storefront", title: "Fix focus rings in cart drawer", updatedAt: NOW - 90 * min, indicator: "unread-success", isUnread: true }),

  // atlas-api
  thread({ id: "thr_atlas_rate", projectId: "prj_atlas", title: "Rate-limit the public search endpoint", updatedAt: NOW - 30 * min, indicator: "unread-error", isUnread: true }),
  thread({ id: "thr_atlas_migrate", projectId: "prj_atlas", title: "Postgres 17 migration plan", updatedAt: NOW - 6 * hour }),

  // pixel-garden
  thread({ id: "thr_garden_tiles", projectId: "prj_garden", title: "Autotile water edges", updatedAt: NOW - 26 * hour }),

  // Personal chats
  thread({ id: "thr_chat_recipe", projectId: "prj_personal", title: "Sourdough schedule for Saturday", updatedAt: NOW - 4 * hour }),
];

export const specialThreads: SpecialThreadDto[] = [
  {
    threadId: "thr_store_reviewer", botId: "projbot_store1", name: "Reviewer", icon: "shield", color: "#7C5CFF",
    instruction: "Before landing non-trivial changes, message Reviewer with your branch and a short summary.",
    rolePrompt: "You are the Reviewer for this project.", createdAt: NOW - 5 * 24 * hour, updatedAt: NOW - 5 * 24 * hour,
  },
  {
    threadId: "thr_store_lander", botId: "projbot_store1", name: "Lander", icon: "rocket", color: "#FF6B6B",
    instruction: "Once Reviewer approves, hand the branch to Lander to merge and deploy.",
    createdAt: NOW - 5 * 24 * hour + 1, updatedAt: NOW - 5 * 24 * hour,
  },
];

const storefrontBot = { id: "projbot_store1", name: "acme-storefront", role: "Project Bot", color: "#FF7A59", kind: "project" };
const atlasBot = { id: "projbot_atlas1", name: "atlas-api", role: "Project Bot", color: "#2EC4B6", kind: "project" };
const chiefBot = { id: "bot_chief", name: "Chief of Staff", role: "Coordinates across projects", color: "#FFC145", kind: "unaffiliated" };

export const inboxMessages: InboxMessage[] = [
  {
    id: 1,
    threadId: "thr_store_cache",
    turnId: "turn_1",
    text: "**How should we cache product pages at the CDN?**\n\nPrices change a few times a day; inventory changes every minute.",
    query: [
      {
        ref: "1",
        kind: "choice",
        text: "Cache strategy for product pages",
        options: [
          { key: "a", label: "Stale-while-revalidate", detail: "60 s fresh, 10 min stale. Instant pages; prices can lag a minute.", recommended: true },
          { key: "b", label: "Short TTL", detail: "15 s TTL, no stale serving. Simpler, more origin load." },
          { key: "c", label: "Purge on publish", detail: "Long TTL plus webhook purges. Needs a purge queue." },
        ],
      },
      {
        ref: "2",
        kind: "multi",
        text: "Which routes should bypass the cache?",
        options: [
          { key: "a", label: "/cart", recommended: true },
          { key: "b", label: "/checkout", recommended: true },
          { key: "c", label: "/account" },
        ],
      },
      { ref: "3", kind: "confirm", text: "Ship behind a feature flag first?" },
    ],
    state: "open",
    answerText: null,
    createdAt: NOW - 12 * min,
    resolvedAt: null,
    bot: storefrontBot,
    threadTitle: "Pick a CDN cache strategy",
    projectId: "prj_storefront",
    projectName: "acme-storefront",
  },
  {
    id: 2,
    threadId: "thr_atlas_rate",
    turnId: "turn_2",
    text: "**Rate limit for anonymous search?** The current spike is ~40 req/s from three IPs.",
    query: [
      { ref: "1", kind: "scale", text: "Requests per minute per IP", scale: { min: 1, max: 5, low: "30/min", high: "300/min" } },
      { ref: "2", kind: "text", text: "Anyone we should allow-list?", placeholder: "IP ranges or API keys" },
    ],
    state: "open",
    answerText: null,
    createdAt: NOW - 30 * min,
    resolvedAt: null,
    bot: atlasBot,
    threadTitle: "Rate-limit the public search endpoint",
    projectId: "prj_atlas",
    projectName: "atlas-api",
  },
  {
    id: 3,
    threadId: "thr_cos_week",
    turnId: "turn_3",
    text: "**Launch week:** storefront and API both want Tuesday. Which goes first?",
    query: [
      {
        ref: "1",
        kind: "choice",
        text: "Release order",
        options: [
          { key: "a", label: "API Tuesday, storefront Thursday", recommended: true, detail: "Storefront depends on the new search params." },
          { key: "b", label: "Both Tuesday" },
        ],
      },
    ],
    state: "open",
    answerText: null,
    createdAt: NOW - 2 * hour,
    resolvedAt: null,
    bot: chiefBot,
    threadTitle: "Weekly launch checklist",
    projectId: "prj_personal",
    projectName: null,
  },
];

export const resolvedToday: InboxMessage[] = [
  {
    id: 4,
    threadId: "thr_store_a11y",
    turnId: "turn_4",
    text: "**Focus ring color?**",
    query: [{ ref: "1", kind: "choice", text: "Focus ring", options: [{ key: "a", label: "Brand blue" }, { key: "b", label: "System default" }] }],
    state: "answered",
    answerText: "1a. Focus ring: Brand blue",
    createdAt: NOW - 3 * hour,
    resolvedAt: NOW - 150 * min,
    bot: storefrontBot,
    threadTitle: "Fix focus rings in cart drawer",
    projectId: "prj_storefront",
    projectName: "acme-storefront",
  },
];

export const proseMessage: InboxMessage = {
  id: 10,
  threadId: "thr_store_cache",
  turnId: "turn_1",
  text: "I measured origin load for the last 24 h: product pages are **71%** of requests, and 93% of those are identical within a minute. Caching them is the single biggest win.",
  state: "prose",
  answerText: null,
  createdAt: NOW - 13 * min,
  resolvedAt: NOW - 13 * min,
  bot: storefrontBot,
  threadTitle: "Pick a CDN cache strategy",
  projectId: "prj_storefront",
  projectName: "acme-storefront",
};
