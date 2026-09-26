import { StructuredCaptureError } from "./structured-capture.ts";

/**
 * ADR 0031: multi-line paste. A Markdown list becomes several tasks (nested
 * items become child tasks, ADR 0018); pasted email text becomes one task
 * whose title is the Subject line and whose notes are the body. Anything
 * else is plain text. Only text is read: raw MIME messages are refused.
 */
export interface PastedChild {
  readonly title: string;
  readonly notes: string;
}

export interface PastedItem extends PastedChild {
  readonly children: readonly PastedChild[];
}

export type PastedCapture =
  | {
      readonly kind: "markdown";
      readonly items: readonly PastedItem[];
      /** `- [x]` items are already done and are not created. */
      readonly skippedCompleted: number;
    }
  | {
      readonly kind: "email";
      readonly title: string;
      readonly notes: string;
      readonly truncated: boolean;
    }
  | { readonly kind: "plain" };

export const pasteMaxLength = 200_000;
export const pasteMaxTasks = 100;
export const pasteTitleMaxLength = 240;
export const pasteNotesMaxLength = 20_000;

const listLine = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(?:\[([ xX])\]\s*)?(.*)$/;
const headingLine = /^\s*#{1,6}\s/;
const headerLine = /^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/;

const normalize = (text: string): string[] =>
  text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

const indentOf = (whitespace: string): number => {
  const tabs = (whitespace.match(/\t/g) ?? []).length;
  const spaces = (whitespace.match(/ /g) ?? []).length;
  return tabs + Math.floor(spaces / 2);
};

const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

const parseEmail = (lines: readonly string[]): PastedCapture | undefined => {
  const start = lines.findIndex((line) => line.trim() !== "");
  if (start < 0) return undefined;
  const headers = new Map<string, string>();
  let index = start;
  let last: string | undefined;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") break;
    const header = headerLine.exec(line);
    if (header !== null) {
      last = header[1]?.toLowerCase();
      if (last !== undefined) headers.set(last, (header[2] ?? "").trim());
    } else if (/^\s/.test(line) && last !== undefined) {
      headers.set(last, `${headers.get(last) ?? ""} ${line.trim()}`.trim());
    } else return undefined;
  }
  const subject = headers.get("subject");
  if (subject === undefined || subject === "") return undefined;
  const contentType = headers.get("content-type") ?? "";
  const encoding = headers.get("content-transfer-encoding") ?? "";
  const body = lines
    .slice(index + 1)
    .join("\n")
    .trim();
  if (
    /multipart\//i.test(contentType) ||
    /base64/i.test(encoding) ||
    /^content-transfer-encoding:\s*base64/im.test(body) ||
    /^content-disposition:\s*attachment/im.test(body)
  )
    throw new StructuredCaptureError(
      "Raw .eml messages with MIME parts or attachments are not supported; paste the message text instead",
    );
  const title = clip(subject.replace(/\s+/g, " "), pasteTitleMaxLength);
  const from = headers.get("from");
  const notes = clip(
    [from === undefined ? undefined : `From: ${from}`, body]
      .filter((part): part is string => part !== undefined && part !== "")
      .join("\n\n"),
    pasteNotesMaxLength,
  );
  return {
    kind: "email",
    title,
    notes,
    truncated:
      subject.replace(/\s+/g, " ").length > pasteTitleMaxLength ||
      notes.length === pasteNotesMaxLength,
  };
};

const parseMarkdown = (lines: readonly string[]): PastedCapture | undefined => {
  const first = lines.find((line) => line.trim() !== "");
  if (first === undefined) return undefined;
  if (!listLine.test(first) && !headingLine.test(first)) return undefined;
  const parsed = lines
    .map((line) => ({ line, match: listLine.exec(line) }))
    .filter(({ match }) => match !== null);
  if (parsed.length === 0) return undefined;
  const minIndent = Math.min(
    ...parsed.map(({ match }) => indentOf(match?.[1] ?? "")),
  );
  const items: {
    title: string;
    notes: string[];
    children: { title: string; notes: string[] }[];
  }[] = [];
  let skippedCompleted = 0;
  let target: { notes: string[] } | undefined;
  let total = 0;
  for (const line of lines) {
    if (line.trim() === "" || headingLine.test(line)) continue;
    const match = listLine.exec(line);
    if (match === null) {
      target?.notes.push(line.trim());
      continue;
    }
    const title = (match[3] ?? "").trim();
    if (title === "") continue;
    if ((match[2] ?? " ").toLowerCase() === "x") {
      skippedCompleted += 1;
      target = undefined;
      continue;
    }
    total += 1;
    if (total > pasteMaxTasks)
      throw new StructuredCaptureError(
        `A pasted list may create at most ${String(pasteMaxTasks)} tasks`,
      );
    const level = indentOf(match[1] ?? "") - minIndent;
    const parent = items.at(-1);
    if (level > 0 && parent !== undefined) {
      const child = { title, notes: [] };
      parent.children.push(child);
      target = child;
    } else {
      const item = { title, notes: [], children: [] };
      items.push(item);
      target = item;
    }
  }
  return {
    kind: "markdown",
    items: items.map((item) => ({
      title: clip(item.title, pasteTitleMaxLength),
      notes: clip(item.notes.join("\n"), pasteNotesMaxLength),
      children: item.children.map((child) => ({
        title: clip(child.title, pasteTitleMaxLength),
        notes: clip(child.notes.join("\n"), pasteNotesMaxLength),
      })),
    })),
    skippedCompleted,
  };
};

export const parsePastedCapture = (text: string): PastedCapture => {
  if (text.length > pasteMaxLength)
    throw new StructuredCaptureError("Pasted text is too long");
  const lines = normalize(text);
  return parseEmail(lines) ?? parseMarkdown(lines) ?? { kind: "plain" };
};
