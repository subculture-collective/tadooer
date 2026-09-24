import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Styled wrapper around a native `<select>`.
 *
 * It renders the real element with no extra wrapper, so it keeps native form
 * semantics: it works inside `<label className="field">`, participates in
 * FormData under its `name`, and inherits the base-layer chevron styling.
 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-[1.875rem] w-full min-w-0 cursor-pointer appearance-none rounded-sm border border-input bg-mantle py-1 pr-7 pl-2.5 text-sm text-foreground transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/25",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

function NativeSelectOption({ ...props }: React.ComponentProps<"option">) {
  return <option data-slot="native-select-option" {...props} />;
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("text-subtext-2", className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOption, NativeSelectOptGroup };
