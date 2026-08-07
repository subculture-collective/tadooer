#!/usr/bin/env node
import { readAutomationTokenFile, parseQuickAddConfig } from "./config.ts";
import { submitQuickAdd } from "./client.ts";

const main = async (): Promise<void> => {
  const config = parseQuickAddConfig(process.argv.slice(2));
  const token = readAutomationTokenFile(config.tokenFile);
  const result = await submitQuickAdd(config, token);
  process.stdout.write(
    `${JSON.stringify({
      previewId: result.previewId,
      operation: result.operation,
      replayed: result.replayed,
      result: result.result,
    })}\n`,
  );
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Quick-add failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
