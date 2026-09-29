import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const withTemporaryDirectory = async <T>(
  run: (directory: string) => Promise<T> | T,
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), "productivity-suite-"));

  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export * from "./caldav-fake.ts";
