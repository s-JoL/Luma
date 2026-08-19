import { Monitor, Moon, Sun } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "./button.tsx";
import { Menu, MenuItem } from "./controls.tsx";

export type ThemeChoice = "dark" | "light" | "system";

const KEY = "luma.theme";
const ThemeContext = createContext<{ choice: ThemeChoice; set: (choice: ThemeChoice) => void }>({
  choice: "dark",
  set: () => {},
});

const stored = (): ThemeChoice => {
  const value = localStorage.getItem(KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "dark";
};

/**
 * The class on `<html>` is what every token block keys off. `system` follows the
 * OS live rather than at load, because someone on a schedule-based dark mode
 * should not have to reload at sunset.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(stored);

  useEffect(() => {
    localStorage.setItem(KEY, choice);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = choice === "dark" || (choice === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#111318" : "#fbfaf9");
    };
    apply();
    if (choice !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [choice]);

  return <ThemeContext.Provider value={{ choice, set: setChoice }}>{children}</ThemeContext.Provider>;
}

const ICONS: Record<ThemeChoice, typeof Sun> = { dark: Moon, light: Sun, system: Monitor };
const LABELS: Record<ThemeChoice, string> = { dark: "深色", light: "浅色", system: "跟随系统" };

export function ThemeToggle() {
  const { choice, set } = useContext(ThemeContext);
  const Icon = ICONS[choice];
  return (
    <Menu
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label={`外观：${LABELS[choice]}`}>
          <Icon />
        </Button>
      }
    >
      {(["dark", "light", "system"] as const).map((option) => {
        const OptionIcon = ICONS[option];
        return (
          <MenuItem key={option} onSelect={() => set(option)}>
            <OptionIcon />
            <span className="flex-1">{LABELS[option]}</span>
            {choice === option ? <span className="text-primary">·</span> : null}
          </MenuItem>
        );
      })}
    </Menu>
  );
}
