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
            providerId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
            endpoint: "http://baikal/dav.php/",
            username: "alice",
            verifiedAt: "2026-08-05T00:00:00.000Z",
            calendars: [
              {
                id: "4519c805-e478-486b-a918-616fc6d9ea98",
                providerId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
                href: "/dav.php/calendars/alice/work/",
                displayName: "Work",
                supportsEvents: true,
                supportsTodos: true,
              },
            ],
          },
          tasks: [
            {
              id: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
              title: "Capture the first task",
              notes: "Retry-safe and owner-scoped",
              status: "open",
              revision: 1,
              createdAt: "2026-08-05T12:00:00.000Z",
              updatedAt: "2026-08-05T12:00:00.000Z",
            },
          ],
        }}
      />,
    );
    expect(markup).toContain("Foundation connected");
    expect(markup).toContain("Events · Todos");
    expect(markup).toContain(
      "Task editing and calendar event reads or writes remain Phase 1 capabilities",
    );
    expect(markup).toContain("Capture a task");
    expect(markup).toContain("Capture the first task");
    expect(markup).toContain("Revision 1");
  });
});
