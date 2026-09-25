import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { NoteMarkdown, safeLinkTarget } from "./NoteMarkdown.tsx";

it("renders the supported Markdown subset", () => {
  const html = renderToStaticMarkup(
    <NoteMarkdown
      content={[
        "# Plan",
        "Ship **bold** and *soft* `code` work.",
        "- [x] done",
        "- [ ] open",
        "",
        "1. first",
        "2. second",
        "> quoted",
        "```",
        "<raw> code",
        "```",
        "See [docs](https://example.com/a) or https://example.org/b.",
      ].join("\n")}
    />,
  );
  expect(html).toContain("<h4>Plan</h4>");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<em>soft</em>");
  expect(html).toContain("<code>code</code>");
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html).toContain('checked=""');
  expect(html).toMatch(/<ol><li>.*first.*<\/li><li>.*second.*<\/li><\/ol>/);
  expect(html).toContain("<blockquote>quoted</blockquote>");
  expect(html).toContain("<pre><code>&lt;raw&gt; code</code></pre>");
  expect(html).toContain(
    '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a>',
  );
  expect(html).toContain('href="https://example.org/b"');
  expect(html).toContain("</a>.</p>");
});

it("never turns note content into markup or script links", () => {
  const html = renderToStaticMarkup(
    <NoteMarkdown
      content={
        '<img src=x onerror="alert(1)"> [click](javascript:alert(1)) [data](data:text/html,x)'
      }
    />,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a ");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(safeLinkTarget("javascript:alert(1)")).toBeUndefined();
  expect(safeLinkTarget("mailto:owner@example.com")).toBe(
    "mailto:owner@example.com",
  );
});
