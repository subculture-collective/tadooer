import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  automationCatalog,
  liveSyncResourceFamilySchema,
} from "@suite/contracts";
import {
  automationOperationFamilies,
  classifyLiveSyncRoute,
  type MutatingMethod,
} from "./resource-families.ts";

/**
 * Drift test for ADR 0045: every route a handler can match must have a live
 * sync classification. The route list is not maintained by hand. It is read
 * from the handler sources: each `/api/...` string literal and each
 * `^/api/...` pattern (a regular expression literal, or a template passed to
 * `new RegExp`) in `apps/server/src/routes/*.ts` is turned into concrete
 * sample paths, and every sample must be classified for every mutating
 * method. A new route therefore fails here until it is added to
 * `resource-families.ts`.
 */

const routesDirectory = fileURLToPath(new URL("../routes/", import.meta.url));
const mutatingMethods: readonly MutatingMethod[] = [
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

/**
 * Expands the subset of regular expression syntax the handlers use into
 * every path it can match: groups, alternation, `?`, and character classes
 * or `\d` with a `{n}` count (one sample character repeated).
 */
const expandPattern = (source: string): string[] => {
  let position = 0;
  const fail = (): never => {
    throw new Error(
      `Route pattern syntax is not supported by the drift test at ${String(position)}: ${source}`,
    );
  };
  const quantified = (options: string[]): string[] => {
    const count = /^\{(\d+)\}/.exec(source.slice(position));
    if (count !== null) {
      position += count[0].length;
      return options.map((option) => option.repeat(Number(count[1])));
    }
    if (source[position] === "?") {
      position += 1;
      return ["", ...options];
    }
    if (source[position] === "*" || source[position] === "+") fail();
    return options;
  };
  const atom = (): string[] => {
    const character = source[position];
    if (character === undefined) return fail();
    if (character === "(") {
      position += 1;
      if (source.startsWith("?:", position)) position += 2;
      const options = alternation();
      if (source[position] !== ")") fail();
      position += 1;
      return quantified(options);
    }
    if (character === "[") {
      const end = source.indexOf("]", position);
      if (end === -1) fail();
      const sample = source[position + 1] === "\\" ? "0" : source[position + 1];
      position = end + 1;
      return quantified([sample ?? fail()]);
    }
    if (character === "\\") {
      const escaped = source[position + 1];
      position += 2;
      if (escaped === "d") return quantified(["0"]);
      if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) fail();
      return quantified([escaped ?? ""]);
    }
    if (".^$".includes(character)) fail();
    position += 1;
    return quantified([character]);
  };
  const sequence = (): string[] => {
    let results = [""];
    while (
      position < source.length &&
      source[position] !== "|" &&
      source[position] !== ")"
    ) {
      const options = atom();
      results = results.flatMap((prefix) =>
        options.map((option) => prefix + option),
      );
    }
    return results;
  };
  function alternation(): string[] {
    const results = sequence();
    while (source[position] === "|") {
      position += 1;
      results.push(...sequence());
    }
    return results;
  }
  const results = alternation();
  if (position !== source.length) fail();
  return results;
};

interface FoundRoute {
  readonly file: string;
  readonly source: string;
  readonly samples: readonly string[];
}

/** Templates the scan cannot resolve; each is classified another way. */
const unresolvedTemplates = new Set([
  // The automation confirm path comes from the catalog, which the
  // automation test below reads directly.
  'automation.ts: `^${automationConfirmPath.replace("{previewId}", "([0-9a-f-]{36})")}$`',
]);

const scanHandlers = (): FoundRoute[] => {
  const found: FoundRoute[] = [];
  for (const file of readdirSync(routesDirectory)
    .filter((name) => name.endsWith(".ts"))
    .toSorted()) {
    const text = readFileSync(join(routesDirectory, file), "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    // String values of the file's constants, so `${root}/order` and
    // `new RegExp(`^${root}/...`)` resolve. A conditional contributes both
    // branches.
    const constants = new Map<string, string[]>();
    const literalValues = (node: ts.Expression): string[] | undefined => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        return [node.text];
      if (ts.isConditionalExpression(node)) {
        const whenTrue = literalValues(node.whenTrue);
        const whenFalse = literalValues(node.whenFalse);
        return whenTrue === undefined || whenFalse === undefined
          ? undefined
          : [...whenTrue, ...whenFalse];
      }
      return undefined;
    };
    const collect = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const values = literalValues(node.initializer);
        if (values !== undefined) constants.set(node.name.text, values);
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);

    const add = (source: string, value: string): void => {
      if (value.startsWith("^")) {
        if (!value.startsWith("^/api/")) return;
        if (!value.endsWith("$"))
          throw new Error(`Unanchored route pattern in ${file}: ${source}`);
        const samples = expandPattern(value.slice(1, -1));
        const pattern = new RegExp(value);
        for (const sample of samples)
          if (!pattern.test(sample))
            throw new Error(
              `Drift test produced ${sample}, which ${source} does not match`,
            );
        found.push({ file, source, samples });
        // A prefix test such as startsWith("/api/templates/") names no route.
      } else if (value.startsWith("/api/") && !value.endsWith("/"))
        found.push({ file, source, samples: [value] });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        add(node.getText(sourceFile), node.text);
      else if (ts.isRegularExpressionLiteral(node)) {
        const text = node.text;
        const body = text.slice(1, text.lastIndexOf("/"));
        // In a literal `\/` is a slash; elsewhere the escape is kept.
        add(text, body.replaceAll("\\/", "/"));
      } else if (ts.isTemplateExpression(node)) {
        const source = node.getText(sourceFile);
        let values: string[] = [node.head.text];
        let resolved = true;
        for (const span of node.templateSpans) {
          const substitutions = ts.isIdentifier(span.expression)
            ? constants.get(span.expression.text)
            : undefined;
          if (substitutions === undefined) {
            resolved = false;
            break;
          }
          values = values.flatMap((prefix) =>
            substitutions.map(
              (substitution) => prefix + substitution + span.literal.text,
            ),
          );
        }
        if (resolved) for (const value of values) add(source, value);
        else if (
          (node.head.text.startsWith("^") || source.includes("/api/")) &&
          !unresolvedTemplates.has(`${file}: ${source}`)
        )
          throw new Error(
            `Route template in ${file} cannot be resolved by the drift test: ${source}`,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
};

describe("live sync route classification (ADR 0045)", () => {
  const found = scanHandlers();

  it("reads the routes of every handler file", () => {
    const samples = new Set(found.flatMap((route) => route.samples));
    // Spot checks that the scan resolves literals, patterns with optional
    // groups, constants and conditional constants.
    for (const sample of [
      "/api/notes",
      "/api/notes/order",
      `/api/notes/${"0".repeat(36)}`,
      `/api/tags/${"0".repeat(36)}`,
      `/api/projects/${"0".repeat(36)}/backlog`,
      `/api/tasks/${"0".repeat(36)}/time-block`,
      `/api/tasks/${"0".repeat(36)}/attachments/${"0".repeat(36)}`,
      `/api/counters/${"0".repeat(36)}/days/0000-00-00`,
      `/api/calendar-bridge/mappings/${"0".repeat(36)}/links/${"0".repeat(36)}/decline-deletion`,
    ])
      expect(samples, sample).toContain(sample);
    expect(samples.size).toBeGreaterThan(150);
    // Every handler file contributes, except those without their own paths.
    const withoutRoutes = new Set(
      readdirSync(routesDirectory)
        .filter((name) => name.endsWith(".ts"))
        .filter((name) => !found.some((route) => route.file === name)),
    );
    expect(
      [...withoutRoutes].filter(
        (name) =>
          // Automation operation modules run under the catalog paths;
          // shared.ts holds helpers, static.ts serves the web app, and
          // hosted-oauth.ts only owns /oauth and /.well-known paths.
          !name.startsWith("automation-") &&
          name !== "shared.ts" &&
          name !== "static.ts" &&
          name !== "hosted-oauth.ts",
      ),
    ).toEqual([]);
  });

  it("classifies every handler route for every mutating method", () => {
    const unclassified = found.flatMap(({ file, samples }) =>
      samples.flatMap((sample) =>
        mutatingMethods
          .filter(
            (method) => classifyLiveSyncRoute(method, sample) === undefined,
          )
          .map((method) => `${file}: ${method} ${sample}`),
      ),
    );
    expect(unclassified).toEqual([]);
  });

  it("classifies every automation catalog path and operation", () => {
    for (const entry of automationCatalog) {
      const sample = entry.apiPath.replace("{previewId}", "0".repeat(36));
      expect(classifyLiveSyncRoute("POST", sample), entry.id).toEqual({
        kind: "automation",
      });
    }
    const operations = automationCatalog
      .filter(
        (entry) => entry.kind === "tool" && entry.id !== "automation.confirm",
      )
      .map((entry) => entry.id);
    expect(operations.length).toBeGreaterThan(50);
    expect(Object.keys(automationOperationFamilies).toSorted()).toEqual(
      operations.toSorted(),
    );
    for (const families of Object.values(automationOperationFamilies))
      for (const family of families)
        expect(liveSyncResourceFamilySchema.safeParse(family).success).toBe(
          true,
        );
  });

  it("names the families of online-only records and leaves feed routes without one", () => {
    const id = "6f1c2c3e-4f0a-4d53-9d6e-0c3b2f6f8a10";
    // ADR 0046: notes are feed records; their family is retired and no
    // route or automation operation emits it.
    for (const [method, path] of [
      ["POST", "/api/notes"],
      ["PUT", "/api/notes/order"],
      ["PATCH", `/api/notes/${id}`],
      ["DELETE", `/api/notes/${id}`],
    ] as const)
      expect(classifyLiveSyncRoute(method, path), path).toEqual({
        kind: "feed",
      });
    expect(automationOperationFamilies["notes.mutate"]).toEqual([]);
    expect(Object.values(automationOperationFamilies).flat()).not.toContain(
      "notes",
    );
    // ADR 0050: saved day orders are feed records. Planning tasks for a
    // date also sets their planned day, which shapes the day plan.
    expect(classifyLiveSyncRoute("PUT", "/api/day-orders/2026-10-03")).toEqual({
      kind: "feed",
    });
    expect(
      classifyLiveSyncRoute("POST", "/api/day-orders/2026-10-03/tasks"),
    ).toEqual({ kind: "families", families: ["task_planning"] });
    expect(automationOperationFamilies["day_order.reorder"]).toEqual([]);
    expect(Object.values(automationOperationFamilies).flat()).not.toContain(
      "day_orders",
    );
    // ADR 0050: stored time entries are feed records. Focus commands keep
    // the `time_entries` family: their tracked time is not in the feed.
    for (const [method, path] of [
      ["POST", "/api/time/entries"],
      ["PATCH", `/api/time/entries/${id}`],
      ["DELETE", `/api/time/entries/${id}`],
    ] as const)
      expect(classifyLiveSyncRoute(method, path), path).toEqual({
        kind: "feed",
      });
    expect(automationOperationFamilies["time_entries.mutate"]).toEqual([]);
    expect(automationOperationFamilies["focus.complete"]).toEqual([
      "focus",
      "time_entries",
    ]);
    expect(
      classifyLiveSyncRoute("POST", "/api/active-session/command"),
    ).toEqual({ kind: "families", families: ["focus", "time_entries"] });
    expect(classifyLiveSyncRoute("PUT", `/api/boards/${id}`)).toEqual({
      kind: "families",
      families: ["boards"],
    });
    expect(classifyLiveSyncRoute("POST", "/api/data/restore/apply")).toEqual({
      kind: "families",
      families: ["all"],
    });
    expect(
      classifyLiveSyncRoute("POST", "/api/imports/super-productivity/apply"),
    ).toEqual({ kind: "families", families: ["all"] });
    expect(classifyLiveSyncRoute("POST", `/api/imports/${id}/apply`)).toEqual({
      kind: "families",
      families: ["all"],
    });
    expect(classifyLiveSyncRoute("POST", "/api/sync/round")).toEqual({
      kind: "feed",
    });
    expect(classifyLiveSyncRoute("DELETE", `/api/tasks/${id}`)).toEqual({
      kind: "feed",
    });
    expect(classifyLiveSyncRoute("PATCH", `/api/tasks/${id}`)).toEqual({
      kind: "families",
      families: ["task_planning"],
    });
    // Reads have no classification, except the OAuth callback, which
    // connects an account in a GET request.
    expect(classifyLiveSyncRoute("GET", "/api/notes")).toBeUndefined();
    expect(
      classifyLiveSyncRoute("GET", "/api/connectors/google/callback"),
    ).toMatchObject({ kind: "families" });
    expect(classifyLiveSyncRoute("POST", "/api/not-a-route")).toBeUndefined();
  });

  it("fails for a route that has no rule", () => {
    // The expander and the classifier together detect an unknown path.
    expect(expandPattern("/api/widgets/([0-9a-f-]{36})(?:/(a|b))?")).toEqual([
      `/api/widgets/${"0".repeat(36)}`,
      `/api/widgets/${"0".repeat(36)}/a`,
      `/api/widgets/${"0".repeat(36)}/b`,
    ]);
    expect(
      classifyLiveSyncRoute("POST", `/api/widgets/${"0".repeat(36)}/a`),
    ).toBeUndefined();
  });
});
