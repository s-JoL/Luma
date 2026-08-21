/**
 * Settings, one section per file. The section lives in the path, so a link can
 * point at one — `/settings/security` — and the back button behaves.
 */
import { Boxes, KeyRound, Plug, Server, SlidersHorizontal, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import type { Bootstrap } from "@shared/types.ts";
import { cn, PageHeader } from "../../ui.tsx";
import { CapabilitiesSection } from "./capabilities.tsx";
import { ModelsSection, ProvidersSection } from "./models.tsx";
import { PromptsSection } from "./prompts.tsx";
import { SecuritySection } from "./security.tsx";
import { ToolsSection } from "./tools.tsx";

type Tab = "providers" | "models" | "tools" | "capabilities" | "prompts" | "security";

/**
 * Ordered the way a deployment is set up: an endpoint, then something to talk to,
 * then the things that do work. Conversation models and generation backends are
 * separate pages because they have almost no settings in common, and the old
 * single list showed every row the union of both. `mcp` is gone as a page of
 * its own: an MCP server and a local image model are both "something that does
 * work when asked", and which of them is implemented as a subprocess is our
 * business rather than the reader's.
 */
const TABS: Array<{ id: Tab; label: string; icon: typeof Boxes }> = [
  { id: "providers", label: "提供方", icon: Plug },
  { id: "models", label: "对话模型", icon: Boxes },
  { id: "tools", label: "工具与后端", icon: Server },
  { id: "capabilities", label: "能力", icon: SlidersHorizontal },
  { id: "prompts", label: "提示词", icon: Terminal },
  { id: "security", label: "安全", icon: KeyRound },
];

/** Where a link to a page that no longer exists should land instead. */
const MOVED: Record<string, Tab> = { mcp: "tools", profiles: "tools" };

function tabFromPath(): Tab {
  const slug = window.location.pathname.replace(/^\/settings\/?/, "");
  if (TABS.some((tab) => tab.id === slug)) return slug as Tab;
  return MOVED[slug] ?? "providers";
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
            {tab === "providers" ? <ProvidersSection reload={reload} /> : null}
            {tab === "models" ? <ModelsSection reload={reload} /> : null}
            {tab === "tools" ? <ToolsSection reload={reload} /> : null}
            {tab === "capabilities" ? <CapabilitiesSection reload={reload} /> : null}
            {tab === "prompts" ? <PromptsSection reload={reload} /> : null}
            {tab === "security" ? <SecuritySection /> : null}
          </div>
        </div>
      </div>
    </>
  );
}
