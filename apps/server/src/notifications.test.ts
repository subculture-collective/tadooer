import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { loadNtfyPublisherConfig, NtfyPublisher } from "./notifications.ts";

describe("private ntfy publisher", () => {
  it("loads only owner-only regular configuration without exposing its token", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "ntfy.json");
      await writeFile(
        path,
        JSON.stringify({
          baseUrl: "http://ntfy",
          topic: "tadooer-owner",
          token: "publisher-token-that-stays-private",
        }),
        { mode: 0o600 },
      );
      expect(loadNtfyPublisherConfig(path)).toMatchObject({
        baseUrl: "http://ntfy",
        topic: "tadooer-owner",
      });
      await chmod(path, 0o644);
      expect(() => loadNtfyPublisherConfig(path)).toThrow("mode-0600");
    });
  });

  it("sends only bounded reminder content and classifies retry uncertainty", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("later", { status: 503 }))
      .mockRejectedValueOnce(new Error("response lost"));
    const publisher = new NtfyPublisher(
      {
        baseUrl: "http://ntfy",
        topic: "tadooer-owner",
        token: "publisher-token-that-stays-private",
      },
      fetcher,
    );
    const input = {
      message: "Write report · 10:00 AM",
      click: "https://tadooer.subcult.tv/tasks?task=task-1",
    };
    await expect(publisher.publish(input)).resolves.toEqual({
      kind: "delivered",
    });
    await expect(publisher.publish(input)).resolves.toMatchObject({
      kind: "retry",
    });
    await expect(publisher.publish(input)).resolves.toMatchObject({
      kind: "uncertain",
    });
    const first = fetcher.mock.calls[0];
    expect(JSON.stringify(first)).toContain("Write report");
    expect(JSON.stringify(first)).not.toContain("notes");
    expect((first?.[1]?.headers as Record<string, string>).Authorization).toBe(
      "Bearer publisher-token-that-stays-private",
    );
  });
});
