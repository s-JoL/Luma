import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

const field =
  "w-full rounded-md border border-input bg-card px-3 text-foreground placeholder:text-muted-foreground/70 " +
  "transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 " +
  "disabled:opacity-60 aria-invalid:border-destructive";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(field, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(field, "resize-y py-2 leading-relaxed", className)} {...props} />;
}

/** Native select, styled to match: a listbox is one place Radix buys us nothing. */
export function NativeSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cn(field, "h-9 appearance-none pr-8", className)} {...props}>
      {children}
    </select>
  );
}

/**
 * Label, control and message as one unit, so a form cannot drift into labels
 * that are not associated with anything.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <label htmlFor={htmlFor} className="text-sm font-medium text-foreground/90">
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
