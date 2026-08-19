/**
 * Settings, one section per file. The section lives in the path, so a link can
 * point at one — `/settings/security` — and the back button behaves.
 */
import { Boxes, KeyRound, Plug, SlidersHorizontal, Sparkles, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import type { Bootstrap } from "@shared/types.ts";
import { cn, PageHeader } from "../../ui.tsx";
import { CapabilitiesSection } from "./capabilities.tsx";
import { McpSection } from "./mcp.tsx";
import { ModelsSection } from "./models.tsx";
import { ProfilesSection } from "./profiles.tsx";
import { PromptsSection } from "./prompts.tsx";
import { SecuritySection } from "./security.tsx";

type Tab = "models" | "profiles" | "capabilities" | "mcp" | "prompts" | "security";

const TABS: Array<{ id: Tab; label: string; icon: typeof Boxes; hint: string }> = [
  { id: "models", label: "模型", icon: Boxes, hint: "提供方、对话与生成模型" },
  { id: "profiles", label: "预设", icon: Sparkles, hint: "每个对话可选的模型与能力组合" },
  { id: "capabilities", label: "能力", icon: SlidersHorizontal, hint: "联网、文件、记忆、创作台、代码" },
  { id: "mcp", label: "MCP", icon: Plug, hint: "外部工具服务器" },
  { id: "prompts", label: "提示词", icon: Terminal, hint: "系统提示与标题生成" },
  { id: "security", label: "安全", icon: KeyRound, hint: "访问码、两步验证、设备" },
];

function tabFromPath(): Tab {
  const slug = window.location.pathname.replace(/^\/settings\/?/, "");
  return TABS.some((tab) => tab.id === slug) ? (slug as Tab) : "models";
}

export function Settings({
  bootstrap,
  reload,
  onOpenRail,
}: {
  bootstrap: Bootstrap;
  reload: () => Promise<void>;
  onOpenRail: () => void;
}) {
  const [tab, setTab] = useState<Tab>(tabFromPath);

  useEffect(() => {
    const onPop = () => setTab(tabFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const open = (id: Tab) => {
    setTab(id);
    // Replace rather than push: flipping sections should not fill the back stack.
    window.history.replaceState({}, "", `/settings/${id}`);
  };

  const active = TABS.find((item) => item.id === tab)!;

  return (
    <>
      <PageHeader title="设置" onOpenRail={onOpenRail}>
        <span className="text-xs text-muted-foreground">Luma {bootstrap.version}</span>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 lg:w-56 lg:flex-col lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-3">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors lg:w-full",
                tab === id
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              onClick={() => open(id)}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
            <p className="text-sm text-muted-foreground">{active.hint}</p>
            {tab === "models" ? <ModelsSection reload={reload} /> : null}
            {tab === "profiles" ? <ProfilesSection reload={reload} /> : null}
            {tab === "capabilities" ? <CapabilitiesSection reload={reload} /> : null}
            {tab === "mcp" ? <McpSection reload={reload} /> : null}
            {tab === "prompts" ? <PromptsSection reload={reload} /> : null}
            {tab === "security" ? <SecuritySection /> : null}
          </div>
        </div>
      </div>
    </>
  );
}
