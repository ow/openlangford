import type { ReactElement, ReactNode } from "react";
import { Tooltip as T } from "radix-ui";

/**
 * A styled hover/focus tooltip for icon buttons (the native `title` is slow, unstyled and absent on touch).
 * Wrap the button: <Tip label="Next page"><button aria-label="Next page">…</button></Tip>.
 */
export function Tip({ label, children, side = "top" }: { label: ReactNode; children: ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Provider delayDuration={150}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content side={side} sideOffset={6}
            className="z-50 max-w-64 rounded-md bg-zinc-900 px-2 py-1 text-xs leading-snug text-white shadow-md">
            {label}
            <T.Arrow className="fill-zinc-900" />
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
