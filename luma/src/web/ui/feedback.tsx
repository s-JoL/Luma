import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { cn } from "./cn.ts";

interface Toast {
  id: number;
  text: string;
  bad: boolean;
}

const ToastContext = createContext<(text: string, bad?: boolean) => void>(() => {});

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, text, bad }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-100 flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto flex max-w-[min(32rem,100%)] items-start gap-2 rounded-lg border " +
                "bg-popover px-3.5 py-2.5 text-sm shadow-xl animate-in-fast",
              toast.bad && "border-destructive/40",
            )}
          >
            {toast.bad ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
            )}
            <span className="min-w-0 break-words whitespace-pre-wrap">{toast.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Wraps an async action with a toast on failure, so no error is swallowed. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async (action: () => Promise<unknown>, success?: string) => {
      try {
        await action();
        if (success) toast(success);
        return true;
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), true);
        return false;
      }
    },
    [toast],
  );
}

/**
 * `aside` is a slot rather than a feature: looking closer at a picture and asking
 * where it came from are the same impulse, so the panel belongs here, but this
 * file stays presentational and the screen supplies whatever does the asking.
 */
export function Lightbox({ src, onClose, aside }: { src: string; onClose: () => void; aside?: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm animate-in-fast"
      onClick={onClose}
    >
      <img src={src} alt="" className="max-h-full max-w-full rounded-md object-contain shadow-2xl" />
      {aside && open ? (
        // Clicks inside are for the panel; the backdrop keeps closing the viewer.
        <div
          className="absolute inset-y-4 right-4 flex items-start justify-end overflow-hidden"
          onClick={(event) => event.stopPropagation()}
        >
          {aside}
        </div>
      ) : null}
      <div className="absolute top-4 right-4 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
        {aside ? (
          <button
            className={cn(
              "rounded-md p-2 text-white transition-colors hover:bg-white/20",
              open ? "bg-white/25" : "bg-white/10",
            )}
            aria-label="来源与参数"
            aria-pressed={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Info className="size-5" />
          </button>
        ) : null}
        <button
          className="rounded-md bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
          aria-label="关闭"
          onClick={onClose}
        >
          <X className="size-5" />
        </button>
      </div>
    </div>
  );
}

/** Centred placeholder for an empty list, a loading screen or a dead end. */
export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground", className)}>
      {children}
    </div>
  );
}
