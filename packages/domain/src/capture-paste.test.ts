import { describe, expect, it } from "vitest";
import { parsePastedCapture, pasteMaxTasks } from "./capture-paste.ts";

describe("parsePastedCapture", () => {
  it("turns a markdown list into top-level items with nested children and notes", () => {
    const text = [
      "# Sprint",
      "- [ ] Plan sprint +Work 30m",
      "  - [ ] Draft agenda",
      "  some detail",
      "  - [x] Book room",
      "\t- Invite team",
      "* Second parent",
      "1. Third parent",
      "   - deeper child",
      "     - deepest is flattened",
      "",
    ].join("\r\n");
    expect(parsePastedCapture(text)).toEqual({
      kind: "markdown",
      skippedCompleted: 1,
      items: [
        {
          title: "Plan sprint +Work 30m",
          notes: "",
          children: [
            { title: "Draft agenda", notes: "some detail" },
            { title: "Invite team", notes: "" },
          ],
        },
        { title: "Second parent", notes: "", children: [] },
        {
          title: "Third parent",
          notes: "",
          children: [
            { title: "deeper child", notes: "" },
            { title: "deepest is flattened", notes: "" },
          ],
        },
      ],
    });
  });

  it("treats a Subject header block as an email and keeps the body as notes", () => {
    const parsed = parsePastedCapture(
      [
        "From: Ada <ada@example.com>",
        "To: me@example.com",
        "Subject: Re: invoice",
        " for August",
        "",
        "Hi,",
        "",
        "please check the invoice.",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      kind: "email",
      title: "Re: invoice for August",
      notes: "From: Ada <ada@example.com>\n\nHi,\n\nplease check the invoice.",
      truncated: false,
    });
  });

  it("clips an overlong subject and refuses MIME messages with attachments", () => {
    const parsed = parsePastedCapture(`Subject: ${"x".repeat(300)}\n\nbody`);
    expect(parsed).toMatchObject({
      kind: "email",
      title: "x".repeat(240),
      truncated: true,
    });
    for (const text of [
      'Subject: a\nContent-Type: multipart/mixed; boundary="b"\n\n--b',
      "Subject: a\n\n--b\nContent-Transfer-Encoding: base64\n\nQUJD",
      "Subject: a\n\nContent-Disposition: attachment; filename=x.bin",
    ])
      expect(() => parsePastedCapture(text)).toThrow("not supported");
  });

  it("returns plain for ordinary text and bounds the task count", () => {
    expect(parsePastedCapture("Just a title 30m")).toEqual({ kind: "plain" });
    expect(parsePastedCapture("Subject line without colon\n- item")).toEqual({
      kind: "plain",
    });
    expect(parsePastedCapture("")).toEqual({ kind: "plain" });
    const many = Array.from(
      { length: pasteMaxTasks + 1 },
      (_, index) => `- item ${String(index)}`,
    ).join("\n");
    expect(() => parsePastedCapture(many)).toThrow("at most 100");
    expect(
      parsePastedCapture(many.split("\n").slice(0, pasteMaxTasks).join("\n")),
    ).toMatchObject({ kind: "markdown" });
  });
});
