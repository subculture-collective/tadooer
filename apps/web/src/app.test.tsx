import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./app.tsx";

describe("App", () => {
  it("renders the one-owner setup contract", () => {
    const markup = renderToStaticMarkup(
      <App initialState={{ kind: "setup" }} />,
    );
    expect(markup).toContain("Create the owner account");
    expect(markup).toContain("at least 14 characters");
    expect(markup).toContain("one owner");
  });

  it("renders discovered event and todo capabilities without claiming event reads", () => {
    const markup = renderToStaticMarkup(
      <App
        initialState={{
          kind: "authenticated",
          session: {
            owner: {
              id: "d1054acd-c04d-4bd8-a814-254b007154ba",
              username: "owner",
              displayName: "Owner",
            },
            csrfToken: "A".repeat(43),
            expiresAt: "2026-08-05T12:00:00.000Z",
          },
          baikal: {
            connected: true,
            endpoint: "http://baikal/dav.php/",
            username: "alice",
            verifiedAt: "2026-08-05T00:00:00.000Z",
            calendars: [
              {
                href: "/dav.php/calendars/alice/work/",
                displayName: "Work",
                supportsEvents: true,
                supportsTodos: true,
              },
            ],
          },
        }}
      />,
    );
    expect(markup).toContain("Foundation connected");
    expect(markup).toContain("Events · Todos");
    expect(markup).toContain(
      "Reading and changing events remains a Phase 1 capability",
    );
  });
});
