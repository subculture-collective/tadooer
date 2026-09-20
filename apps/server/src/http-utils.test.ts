import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { readJson, maxJsonBytes } from "./http-utils.ts";

const request = (parts: Buffer[]) => {
  const stream = Object.assign(new PassThrough(), {
    headers: { "content-type": "application/json" },
  });
  for (const part of parts) stream.write(part);
  stream.end();
  return stream as unknown as IncomingMessage;
};
it("enforces byte budgets on streamed JSON without relying on content length", async () => {
  const json = Buffer.from('{"value":"é"}');
  await expect(
    readJson(request([json.subarray(0, 11), json.subarray(11)]), json.length),
  ).resolves.toEqual({ value: "é" });
  await expect(readJson(request([json]), json.length - 1)).rejects.toThrow(
    "BODY_TOO_LARGE",
  );
  await expect(readJson(request([Buffer.from("{")]))).rejects.toThrow(
    "INVALID_JSON",
  );
  await expect(
    readJson(request([Buffer.from(" ".repeat(maxJsonBytes + 1))])),
  ).rejects.toThrow("BODY_TOO_LARGE");
});
