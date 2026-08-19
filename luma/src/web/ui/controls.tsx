import { cva, type VariantProps } from "class-variance-authority";
import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu, Select as SelectPrimitive, Switch as SwitchPrimitive, Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  const control = (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5 " +
          "transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 " +
          "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input disabled:opacity-50",
      )}
    >
      <SwitchPrimitive.Thumb
        className={
          "pointer-events-none block size-4 rounded-full bg-card shadow transition-transform " +
          "data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
        }
      />
    </SwitchPrimitive.Root>
  );

  if (!label) return control;
  return (
    <label className="flex cursor-pointer items-start gap-2.5 select-none">
      {control}
      <span className="flex flex-col gap-0.5">
        <span className="text-sm leading-5">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

export interface Option<T extends string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

/**
 * Radix reserves the empty string for "nothing selected", but here it is a real
 * choice — "follow the global setting", "no preset". It travels as a sentinel so
 * callers can keep using `""` and still see the option's own label on the
 * closed trigger instead of the placeholder.
 */
const NONE = "\u0000none";
const encode = (value: string) => value || NONE;
const decode = (value: string) => (value === NONE ? "" : value);

/**
 * A listbox that can show two lines per option and be styled on every platform,
 * which a native `<select>` cannot. Used where the choice carries a subtitle —
 * a model with its provider, a profile with what it turns on.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder = "选择…",
  className,
  triggerLabel,
  align = "start",
  disabled,
}: {
  value: T | "";
  onChange: (value: T) => void;
  options: Array<Option<T>>;
  placeholder?: string;
  className?: string;
  /** Overrides what the closed trigger shows; the value's label by default. */
  triggerLabel?: ReactNode;
  align?: "start" | "center" | "end";
  disabled?: boolean;
}) {
  // An option list that offers no empty choice keeps the placeholder for an
  // unset value, which is what an unconfigured model switcher should show.
  const offersNone = options.some((option) => option.value === "");
  const current = value === "" && !offersNone ? undefined : encode(value);

  return (
    <SelectPrimitive.Root
      value={current}
      onValueChange={(next) => onChange(decode(next) as T)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        className={cn(
          "inline-flex h-9 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 " +
            "text-left transition-colors outline-none hover:bg-accent/50 focus-visible:border-ring " +
            "focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:opacity-60 data-[placeholder]:text-muted-foreground",
          className,
        )}
      >
        {triggerLabel ? (
          <span className="truncate">{triggerLabel}</span>
        ) : (
          <SelectPrimitive.Value placeholder={placeholder} />
        )}
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          align={align}
          sideOffset={6}
          className={
            "z-50 max-h-[min(24rem,60dvh)] min-w-[var(--radix-select-trigger-width)] overflow-y-auto " +
            "rounded-lg border bg-popover p-1 shadow-xl data-[state=open]:animate-in-fast"
          }
        >
          {options.map((option) => (
            <SelectPrimitive.Item
              key={option.value}
              value={encode(option.value)}
              disabled={option.disabled}
              className={
                "relative flex cursor-pointer flex-col gap-0.5 rounded-sm py-1.5 pr-8 pl-2.5 outline-none " +
                "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground " +
                "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              }
            >
              <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              {option.hint ? <span className="text-xs text-muted-foreground">{option.hint}</span> : null}
              <SelectPrimitive.ItemIndicator className="absolute top-2 right-2.5">
                <Check className="size-4 text-primary" />
              </SelectPrimitive.ItemIndicator>
            </SelectPrimitive.Item>
          ))}
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Menu({
  trigger,
  children,
  align = "end",
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          className="z-50 min-w-44 rounded-lg border bg-popover p-1 shadow-xl data-[state=open]:animate-in-fast"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  className,
  danger,
  ...props
}: ComponentProps<typeof DropdownMenu.Item> & { danger?: boolean }) {
  return (
    <DropdownMenu.Item
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none " +
          "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-4",
        danger && "text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

export function Tooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={350}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-lg"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

const badge = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", {
  variants: {
    tone: {
      neutral: "bg-secondary text-secondary-foreground",
      accent: "bg-accent text-accent-foreground",
      success: "bg-success/15 text-success",
      warning: "bg-warning/15 text-warning",
      danger: "bg-destructive/15 text-destructive",
      outline: "border text-muted-foreground",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
      role="status"
      aria-label="进行中"
    />
  );
}
