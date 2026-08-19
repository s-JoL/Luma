import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

const overlay =
  "fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] data-[state=open]:animate-in-fast";

/** A centred modal. Escape and the backdrop both close it, via Radix. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  className,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className={overlay} />
        <Primitive.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[88dvh] w-[min(34rem,calc(100vw-2rem))] " +
              "-translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-popover p-5 shadow-2xl " +
              "data-[state=open]:animate-in-fast",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Primitive.Title className="text-lg font-semibold">{title}</Primitive.Title>
              {description ? (
                <Primitive.Description className="text-sm text-muted-foreground">
                  {description}
                </Primitive.Description>
              ) : null}
            </div>
            <Primitive.Close
              aria-label="关闭"
              className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </Primitive.Close>
          </div>
          {children ? <div className="min-h-0 overflow-y-auto">{children}</div> : null}
          {footer ? <div className="flex justify-end gap-2">{footer}</div> : null}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

/**
 * The same modal machinery pinned to an edge. On a phone the conversation rail
 * is this, which is why it has to trap focus and close on Escape rather than
 * being a div with a class.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className={overlay} />
        <Primitive.Content
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex w-[min(19rem,86vw)] flex-col bg-sidebar " +
              "border-r border-sidebar-border shadow-2xl data-[state=open]:animate-in-fast",
            className,
          )}
        >
          <Primitive.Title className="sr-only">{title}</Primitive.Title>
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border bg-card", className)} {...props} />;
}
