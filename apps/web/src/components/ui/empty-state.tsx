import * as React from "react";

import { cn } from "@/lib/utils";

type EmptyStateProps = Omit<React.ComponentProps<"div">, "title"> & {
  /** Optional icon rendered above the title. */
  icon?: React.ReactNode;
  /** Short headline; falls back to `children` when omitted. */
  title?: React.ReactNode;
  /** Secondary copy under the title. */
  description?: React.ReactNode;
  /** Action slot, usually a Button. */
  action?: React.ReactNode;
};

function EmptyState({
  className,
  icon,
  title,
  description,
  action,
  children,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-subtext",
        className,
      )}
      {...props}
    >
      {icon !== undefined && (
        <div
          data-slot="empty-state-icon"
          aria-hidden="true"
          className="flex size-8 items-center justify-center rounded-md bg-surface-1 text-subtext-2 [&_svg]:size-4"
        >
          {icon}
        </div>
      )}
      {title !== undefined && (
        <div
          data-slot="empty-state-title"
          className="text-base font-semibold text-foreground"
        >
          {title}
        </div>
      )}
      {description !== undefined && (
        <p
          data-slot="empty-state-description"
          className="max-w-prose text-sm text-subtext"
        >
          {description}
        </p>
      )}
      {children}
      {action !== undefined && (
        <div
          data-slot="empty-state-action"
          className="mt-1 flex items-center gap-2"
        >
          {action}
        </div>
      )}
    </div>
  );
}

export { EmptyState };
export type { EmptyStateProps };
