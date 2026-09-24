import * as React from "react";

import { cn } from "@/lib/utils";

type PageHeaderProps = Omit<React.ComponentProps<"header">, "title"> & {
  /** Small uppercase line above the title (the `.step` line in `.today-header`). */
  eyebrow?: React.ReactNode;
  /** Page title, rendered as an h1. */
  title: React.ReactNode;
  /** Secondary copy under the title. */
  description?: React.ReactNode;
  /** Right-aligned action slot; stacks under the text below 640px. */
  actions?: React.ReactNode;
};

function PageHeader({
  className,
  eyebrow,
  title,
  description,
  actions,
  children,
  ...props
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "flex flex-col gap-3 pb-1 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
      {...props}
    >
      <div data-slot="page-header-text" className="grid min-w-0 gap-1">
        {eyebrow !== undefined && (
          <p
            data-slot="page-header-eyebrow"
            className="text-2xs font-semibold tracking-[0.09em] text-primary uppercase"
          >
            {eyebrow}
          </p>
        )}
        <h1
          data-slot="page-header-title"
          className="text-2xl font-[650] tracking-[-0.015em] text-foreground"
        >
          {title}
        </h1>
        {description !== undefined && (
          <p
            data-slot="page-header-description"
            className="text-sm text-subtext"
          >
            {description}
          </p>
        )}
        {children}
      </div>
      {actions !== undefined && (
        <div
          data-slot="page-header-actions"
          className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end"
        >
          {actions}
        </div>
      )}
    </header>
  );
}

export { PageHeader };
export type { PageHeaderProps };
