import * as React from "react";

import { cn } from "@/lib/utils";

type SectionHeadingProps = Omit<React.ComponentProps<"div">, "title"> & {
  /** Small uppercase line above the heading. */
  eyebrow?: React.ReactNode;
  /** Heading text, rendered as an h2 by default. */
  title: React.ReactNode;
  /** Heading level; h2 matches `.section-heading h2`. */
  as?: "h2" | "h3";
  /** Right-aligned slot for counts, filters, or actions. */
  actions?: React.ReactNode;
};

function SectionHeading({
  className,
  eyebrow,
  title,
  as: Heading = "h2",
  actions,
  children,
  ...props
}: SectionHeadingProps) {
  return (
    <div
      data-slot="section-heading"
      className={cn(
        "flex flex-wrap items-start justify-between gap-2",
        className,
      )}
      {...props}
    >
      <div data-slot="section-heading-text" className="grid min-w-0 gap-0.5">
        {eyebrow !== undefined && (
          <p
            data-slot="section-heading-eyebrow"
            className="text-2xs font-semibold tracking-[0.09em] text-subtext-2 uppercase"
          >
            {eyebrow}
          </p>
        )}
        <Heading
          data-slot="section-heading-title"
          className={cn(
            "m-0 text-foreground",
            Heading === "h2"
              ? "text-lg font-semibold tracking-[-0.005em]"
              : "text-base font-semibold",
          )}
        >
          {title}
        </Heading>
        {children}
      </div>
      {actions !== undefined && (
        <div
          data-slot="section-heading-actions"
          className="flex shrink-0 items-center gap-2"
        >
          {actions}
        </div>
      )}
    </div>
  );
}

export { SectionHeading };
export type { SectionHeadingProps };
