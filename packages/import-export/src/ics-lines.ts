// iCalendar line helpers shared by the import preview and the subscription
// feed parser (issue #91).

/** Largest ICS input the parsers accept (bytes). */
export const icsMaxBytes = 4 * 1024 * 1024;

/**
 * Unfolds iCalendar lines. Undefined for oversized or NUL-bearing input.
 * Shared by the import preview and the subscription feed parser.
 */
export const unfoldIcsLines = (raw: string): readonly string[] | undefined => {
  if (Buffer.byteLength(raw, "utf8") > icsMaxBytes || raw.includes("\0"))
    return undefined;
  const normalized = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const output: string[] = [];
  for (const line of normalized.split("\n")) {
    if (/^[ \t]/.test(line) && output.length > 0)
      output[output.length - 1] = `${output.at(-1) ?? ""}${line.slice(1)}`;
    else output.push(line);
  }
  return output;
};

/** Splits unfolded lines into VEVENT components, nested components included. */
export const splitVEventComponents = (
  lines: readonly string[],
): {
  readonly components: readonly (readonly string[])[];
  readonly closed: boolean;
} => {
  const components: string[][] = [];
  let current: string[] | undefined;
  let depth = 0;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT" && current === undefined) {
      current = [line];
      depth = 1;
    } else if (current !== undefined) {
      current.push(line);
      if (line.startsWith("BEGIN:")) depth += 1;
      if (line.startsWith("END:")) depth -= 1;
      if (line === "END:VEVENT" && depth === 0) {
        components.push(current);
        current = undefined;
      }
    }
  }
  return { components, closed: current === undefined };
};
