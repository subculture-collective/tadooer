import type { ReactNode } from "react";

/**
 * Renders the supported note Markdown subset as React elements. Content is
 * never passed to the DOM as HTML: raw tags display as text. Supported:
 * headings, paragraphs, bullet/numbered/checkbox lists, quotes, fenced code,
 * inline code, bold, italic, [text](url) and bare URLs. Links accept only
 * http, https and mailto targets; other targets render as plain text.
 */
export const safeLinkTarget = (target: string): string | undefined => {
  try {
    const url = new URL(target);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

const inlinePattern =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])|(\*[^*\s][^*\n]*\*)|(_[^_\s][^_\n]*_)/g;

const link = (label: ReactNode, target: string, key: string): ReactNode => {
  const href = safeLinkTarget(target);
  return href === undefined ? (
    <span key={key}>{label}</span>
  ) : (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
};

export const renderInline = (text: string, keyPrefix = "i"): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const [token] = match;
    const start = match.index;
    if (start > last) nodes.push(text.slice(last, start));
    const key = `${keyPrefix}-${String(index++)}`;
    if (match[1] !== undefined)
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (match[2] !== undefined)
      nodes.push(
        <strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>,
      );
    else if (match[3] !== undefined) {
      const split = token.indexOf("](");
      nodes.push(
        link(
          renderInline(token.slice(1, split), key),
          token.slice(split + 2, -1),
          key,
        ),
      );
    } else if (match[4] !== undefined) nodes.push(link(token, token, key));
    else nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
};

type ListKind = "ul" | "ol" | "check";

export const NoteMarkdown = ({ content }: { readonly content: string }) => {
  const blocks: ReactNode[] = [];
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];
  let list: {
    kind: ListKind;
    items: { text: string; checked: boolean }[];
  } | null = null;
  let quote: string[] = [];
  const key = () => `b-${String(blocks.length)}`;
  const flush = () => {
    if (paragraph.length > 0) {
      const k = key();
      blocks.push(<p key={k}>{renderInline(paragraph.join(" "), k)}</p>);
      paragraph = [];
    }
    if (quote.length > 0) {
      const k = key();
      blocks.push(
        <blockquote key={k}>{renderInline(quote.join(" "), k)}</blockquote>,
      );
      quote = [];
    }
    if (list !== null) {
      const k = key();
      const items = list.items.map((item, index) => (
        <li key={`${k}-${String(index)}`}>
          {list?.kind === "check" && (
            <input
              type="checkbox"
              checked={item.checked}
              disabled
              aria-label={item.checked ? "Done" : "Not done"}
            />
          )}{" "}
          {renderInline(item.text, `${k}-${String(index)}`)}
        </li>
      ));
      blocks.push(
        list.kind === "ol" ? (
          <ol key={k}>{items}</ol>
        ) : (
          <ul
            key={k}
            className={list.kind === "check" ? "note-checklist" : undefined}
          >
            {items}
          </ul>
        ),
      );
      list = null;
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      index++;
      while (
        index < lines.length &&
        !(lines[index] ?? "").trimStart().startsWith("```")
      )
        code.push(lines[index++] ?? "");
      blocks.push(
        <pre key={key()}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const check = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quoted = /^>\s?(.*)$/.exec(line);
    if (line.trim() === "") flush();
    else if (heading !== null) {
      flush();
      const k = key();
      const text = renderInline(heading[2] ?? "", k);
      const level = (heading[1] ?? "#").length;
      blocks.push(
        level <= 2 ? (
          <h4 key={k}>{text}</h4>
        ) : level <= 4 ? (
          <h5 key={k}>{text}</h5>
        ) : (
          <h6 key={k}>{text}</h6>
        ),
      );
    } else if (check !== null || bullet !== null || numbered !== null) {
      const kind: ListKind =
        check !== null ? "check" : bullet !== null ? "ul" : "ol";
      if (
        paragraph.length > 0 ||
        quote.length > 0 ||
        (list !== null && list.kind !== kind)
      )
        flush();
      list ??= { kind, items: [] };
      list.items.push({
        text: (check?.[2] ?? bullet?.[1] ?? numbered?.[1] ?? "").trim(),
        checked: check !== null && check[1] !== " ",
      });
    } else if (quoted !== null) {
      if (paragraph.length > 0 || list !== null) flush();
      quote.push(quoted[1] ?? "");
    } else {
      if (list !== null || quote.length > 0) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return <div className="note-markdown">{blocks}</div>;
};
