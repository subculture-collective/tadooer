/**
 * Share-target capture (ADR 0049). A phone shell receives shared text from
 * another app and hands it to the web app's quick capture as one line. This
 * module turns what the other app sent into that line. It is pure, and the
 * result is only ever placed in the capture field for the owner to review; it
 * is never submitted by the shell.
 */

/** A task title is at most 240 characters (`packages/contracts`). */
export const captureTextLimit = 240;

/** Longer input is cut before any other work is done on it. */
const inputLimit = 8192;

const oneLine = (value) => {
  if (typeof value !== "string") return "";
  let line = "";
  let gap = false;
  for (const character of value.slice(0, inputLimit)) {
    const code = character.codePointAt(0) ?? 0;
    // Control characters, line breaks and every kind of space become one gap.
    if (code < 0x20 || code === 0x7f || /\s/u.test(character)) {
      gap = line !== "";
      continue;
    }
    // A lone surrogate from a cut pair is dropped.
    if (code >= 0xd800 && code <= 0xdfff) continue;
    line += gap ? ` ${character}` : character;
    gap = false;
  }
  return line;
};

const cut = (text, limit) => Array.from(text).slice(0, limit).join("").trim();

/**
 * The capture line for a share, or undefined when there is nothing to
 * capture. Android browsers send the page title as `subject` and the address
 * as `text`; other apps send `text` alone.
 *
 * The subject comes first, then the text. When both do not fit in a title the
 * subject is shortened first, so a shared address stays whole when it can.
 */
export const shareCaptureText = (share) => {
  if (typeof share !== "object" || share === null || Array.isArray(share))
    return undefined;
  const text = oneLine(share.text);
  const subject = oneLine(share.subject);
  if (text === "" && subject === "") return undefined;
  if (text === "") return cut(subject, captureTextLimit);
  if (subject === "" || text.includes(subject))
    return cut(text, captureTextLimit);
  const textLength = Array.from(text).length;
  const room = captureTextLimit - textLength - 1;
  if (room < 8) return cut(text, captureTextLimit);
  return `${cut(subject, room)} ${text}`;
};
