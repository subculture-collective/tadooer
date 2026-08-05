import { resolve } from "node:path";
import { SuiteDatabase } from "@suite/persistence";

const [, , command, destinationArgument] = process.argv;

if (command !== "backup" || destinationArgument === undefined) {
  console.error("Usage: node dist/cli.mjs backup <destination.sqlite>");
  process.exitCode = 2;
} else {
  const source = resolve(
    process.env.SUITE_DATABASE_PATH ?? "./data/suite.sqlite",
  );
  const destination = resolve(destinationArgument);
  const database = SuiteDatabase.open(source);
  try {
    database.backup(destination);
    console.log(destination);
  } finally {
    database.close();
  }
}
