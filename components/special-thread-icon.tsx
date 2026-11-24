import type { SpecialThreadIconId } from "../contract";

export const SPECIAL_THREAD_COLORS = [
  "#f59e0b", // amber
  "#ef4444", // red
  "#6366f1", // indigo
  "#10b981", // emerald
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#8b5cf6", // violet
  "#f97316", // orange
] as const;

export const SPECIAL_THREAD_ICON_LABELS: Record<SpecialThreadIconId, string> = {
  rocket: "Rocket",
  merge: "Merge",
  shield: "Shield",
  sparkles: "Sparkles",
  flame: "Flame",
  compass: "Compass",
  wrench: "Wrench",
  crown: "Crown",
};

export type SpecialThreadPreset = {
  id: string;
  label: string;
  name: string;
  icon: SpecialThreadIconId;
  color: string;
  instruction: string;
  rolePrompt: string;
};

export const SPECIAL_THREAD_PRESETS: readonly SpecialThreadPreset[] = [
  {
    id: "lander",
    label: "Lander",
    name: "Lander",
    icon: "merge",
    color: "#f59e0b",
    instruction:
      "Always do your changes in an isolated git worktree rather than committing directly to main. When your work is verified and ready to merge, send a message to Lander with your worktree directory path, branch name, and a short summary of the changes. Do not merge or push to main yourself — Lander owns merging, conflict resolution, and pushing.",
    rolePrompt:
      "You are the Lander for this repository. Other threads work in git worktrees and message you with their worktree directory when ready. Your job is to inspect their branch/worktree, rebase or merge cleanly into main, resolve any merge conflicts, run verification/tests, push to origin, and report back if anything blocks landing.",
  },
  {
    id: "deployer",
    label: "Deployer",
    name: "Deployer",
    icon: "rocket",
    color: "#ef4444",
    instruction:
      "Do not deploy or release changes directly. Once changes have landed on main and are ready to ship, message Deployer with the commit SHA, what changed, and any migration or rollout notes.",
    rolePrompt:
      "You are the Deployer for this project. Other threads notify you when changes are ready to release. Your job is to verify builds/checks, run deployment or reload steps safely, confirm live health, and report status back.",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    name: "Reviewer",
    icon: "shield",
    color: "#6366f1",
    instruction:
      "Before landing non-trivial changes, message Reviewer with your branch or worktree path and a brief summary so it can review diffs for correctness, edge cases, and regressions.",
    rolePrompt:
      "You are the Reviewer for this project. Inspect diffs and branches sent by sibling threads, look for bugs, regressions, security issues, and missing tests, and reply concisely with concrete findings or approval.",
  },
];

function IconGlyph({ icon, className }: { icon: SpecialThreadIconId; className?: string }) {
  switch (icon) {
    case "rocket":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
      );
    case "merge":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M6 21V9a9 9 0 0 0 9 9" />
        </svg>
      );
    case "shield":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "sparkles":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
        </svg>
      );
    case "flame":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
        </svg>
      );
    case "compass":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <circle cx="12" cy="12" r="10" />
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
        </svg>
      );
    case "wrench":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case "crown":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
          <path d="M5 21h14" />
        </svg>
      );
  }
}

export function SpecialThreadBadgeIcon({
  icon,
  color = "#f59e0b",
  size = "sm",
}: {
  icon: SpecialThreadIconId;
  color?: string;
  size?: "sm" | "md";
}) {
  const boxClass = size === "md" ? "size-7 rounded-lg" : "size-[18px] rounded-[5px]";
  const glyphClass = size === "md" ? "size-4" : "size-3";
  return (
    <span
      aria-hidden="true"
      className={`pb-special-icon inline-flex shrink-0 items-center justify-center border shadow-xs ${boxClass}`}
      style={{
        background: `linear-gradient(135deg, ${color}33 0%, ${color}18 100%)`,
        borderColor: `${color}66`,
        color,
      }}
    >
      <IconGlyph icon={icon} className={glyphClass} />
    </span>
  );
}
