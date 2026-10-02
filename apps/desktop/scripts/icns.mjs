import { Buffer } from "node:buffer";

/**
 * Writer and reader for the Apple icon container (`.icns`). The container is
 * the four bytes `icns`, the total length, and then one entry per image: a
 * four-character type, the entry length including its eight-byte header, and
 * the image data. Every entry written here holds a PNG, which macOS has
 * accepted for these types since 10.7.
 *
 * No macOS tool is involved, so the icon can be regenerated on Linux
 * (`scripts/make-mac-assets.mjs`).
 */

/** The entries of the application icon and the pixel size each one holds. */
export const icnsImageTypes = Object.freeze([
  Object.freeze({ type: "icp4", pixels: 16 }),
  Object.freeze({ type: "icp5", pixels: 32 }),
  Object.freeze({ type: "ic07", pixels: 128 }),
  Object.freeze({ type: "ic08", pixels: 256 }),
  Object.freeze({ type: "ic09", pixels: 512 }),
  Object.freeze({ type: "ic10", pixels: 1024 }),
  // The "@2x" variants of 16, 32, 128 and 256 points.
  Object.freeze({ type: "ic11", pixels: 32 }),
  Object.freeze({ type: "ic12", pixels: 64 }),
  Object.freeze({ type: "ic13", pixels: 256 }),
  Object.freeze({ type: "ic14", pixels: 512 }),
]);

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Width, height and colour type of a PNG, read from its header chunk.
 * Throws when the data does not start as a PNG. Colour types 4 and 6 have an
 * alpha channel.
 */
export const pngHeader = (data) => {
  if (
    !Buffer.isBuffer(data) ||
    data.length < 33 ||
    !data.subarray(0, 8).equals(pngSignature) ||
    data.toString("latin1", 12, 16) !== "IHDR"
  )
    throw new Error("The image is not a PNG");
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bitDepth: data.readUInt8(24),
    colorType: data.readUInt8(25),
  };
};

/** Builds an `.icns` file from `[{ type, data }]`, where data is a PNG. */
export const writeIcns = (images) => {
  if (!Array.isArray(images) || images.length === 0)
    throw new Error("An icon needs at least one image");
  const seen = new Set();
  const parts = [];
  for (const { type, data } of images) {
    const expected = icnsImageTypes.find((entry) => entry.type === type);
    if (expected === undefined)
      throw new Error(`Unknown icon type: ${String(type)}`);
    if (seen.has(type)) throw new Error(`Duplicate icon type: ${type}`);
    seen.add(type);
    const { width, height } = pngHeader(data);
    if (width !== expected.pixels || height !== expected.pixels)
      throw new Error(
        `Icon type ${type} needs a ${String(expected.pixels)} pixel square image`,
      );
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "latin1");
    header.writeUInt32BE(data.length + 8, 4);
    parts.push(header, data);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "latin1");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
};

/** Reads an `.icns` file into `[{ type, data }]`, checking every length. */
export const readIcns = (file) => {
  if (
    !Buffer.isBuffer(file) ||
    file.length < 8 ||
    file.toString("latin1", 0, 4) !== "icns"
  )
    throw new Error("The file is not an icns icon");
  if (file.readUInt32BE(4) !== file.length)
    throw new Error("The icon's recorded length does not match the file");
  const images = [];
  let offset = 8;
  while (offset < file.length) {
    if (offset + 8 > file.length)
      throw new Error("The icon ends inside an entry header");
    const type = file.toString("latin1", offset, offset + 4);
    const length = file.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > file.length)
      throw new Error(`Icon entry ${type} has an impossible length`);
    images.push({ type, data: file.subarray(offset + 8, offset + length) });
    offset += length;
  }
  return images;
};
