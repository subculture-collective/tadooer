/**
 * A small XML property-list writer and reader for the macOS packaging step:
 * the entitlements files are generated with `buildPlist`, and the packaged
 * `Info.plist` is read back with `parsePlist` to check what was built.
 *
 * Supported values: objects (`dict`), arrays, strings, booleans and integers.
 * The reader also accepts `real`, `date` and `data` elements and returns
 * their text. Binary property lists are not supported.
 */

const escapeText = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const unescapeText = (text) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

const node = (value, indent) => {
  if (typeof value === "string")
    return [`${indent}<string>${escapeText(value)}</string>`];
  if (typeof value === "boolean")
    return [`${indent}<${value ? "true" : "false"}/>`];
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("A property list number must be an integer");
    return [`${indent}<integer>${String(value)}</integer>`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}<array/>`];
    return [
      `${indent}<array>`,
      ...value.flatMap((item) => node(item, `${indent}  `)),
      `${indent}</array>`,
    ];
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${indent}<dict/>`];
    return [
      `${indent}<dict>`,
      ...entries.flatMap(([key, item]) => [
        `${indent}  <key>${escapeText(key)}</key>`,
        ...node(item, `${indent}  `),
      ]),
      `${indent}</dict>`,
    ];
  }
  throw new Error("Unsupported property list value");
};

/** A complete XML property list document for a value. */
export const buildPlist = (value) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    ...node(value, "  "),
    "</plist>",
    "",
  ].join("\n");

const textElements = ["string", "integer", "real", "date", "data", "key"];

/** Reads an XML property list document into plain values. */
export const parsePlist = (xml) => {
  if (typeof xml !== "string") throw new Error("A property list must be text");
  const body = xml
    .replace(/<\?xml[\s\S]*?\?>/, "")
    .replace(/<!DOCTYPE[\s\S]*?>/, "")
    .replaceAll(/<!--[\s\S]*?-->/g, "");
  const tokens = [];
  const pattern = /<(\/?)([A-Za-z]+)([^<>]*?)(\/?)>|([^<]+)/g;
  for (const match of body.matchAll(pattern)) {
    if (match[5] !== undefined) tokens.push({ kind: "text", text: match[5] });
    else if (match[4] === "/") tokens.push({ kind: "empty", name: match[2] });
    else if (match[1] === "/") tokens.push({ kind: "close", name: match[2] });
    else tokens.push({ kind: "open", name: match[2] });
  }
  let position = 0;
  const skipSpace = () => {
    while (
      position < tokens.length &&
      tokens[position].kind === "text" &&
      tokens[position].text.trim() === ""
    )
      position += 1;
  };
  const next = () => {
    skipSpace();
    const token = tokens[position];
    if (token === undefined) throw new Error("The property list ends early");
    position += 1;
    return token;
  };
  const expectClose = (name) => {
    const token = next();
    if (token.kind !== "close" || token.name !== name)
      throw new Error(`Expected </${name}> in the property list`);
  };
  const text = (name) => {
    let value = "";
    while (position < tokens.length && tokens[position].kind === "text") {
      value += tokens[position].text;
      position += 1;
    }
    expectClose(name);
    return unescapeText(value);
  };
  const value = (token) => {
    if (token.kind === "text")
      throw new Error("Unexpected text in the property list");
    if (token.kind === "close")
      throw new Error(`Unexpected </${token.name}> in the property list`);
    const { name } = token;
    if (name === "true" || name === "false") {
      if (token.kind === "open") expectClose(name);
      return name === "true";
    }
    if (textElements.includes(name)) {
      const content = token.kind === "empty" ? "" : text(name);
      if (name !== "integer") return content;
      if (!/^-?[0-9]+$/.test(content.trim()))
        throw new Error("An integer in the property list is malformed");
      return Number(content.trim());
    }
    if (name === "array") {
      const items = [];
      if (token.kind === "empty") return items;
      for (;;) {
        const item = next();
        if (item.kind === "close" && item.name === "array") return items;
        items.push(value(item));
      }
    }
    if (name === "dict") {
      const result = {};
      if (token.kind === "empty") return result;
      for (;;) {
        const key = next();
        if (key.kind === "close" && key.name === "dict") return result;
        if (key.name !== "key" || key.kind === "close")
          throw new Error("A dict entry in the property list has no key");
        const keyName = key.kind === "empty" ? "" : text("key");
        // Own property even for a key such as `__proto__`.
        Object.defineProperty(result, keyName, {
          value: value(next()),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    throw new Error(`Unsupported property list element <${name}>`);
  };
  const root = next();
  if (root.kind !== "open" || root.name !== "plist")
    throw new Error("The document is not a property list");
  const result = value(next());
  expectClose("plist");
  skipSpace();
  if (position !== tokens.length)
    throw new Error("Unexpected content after the property list");
  return result;
};
