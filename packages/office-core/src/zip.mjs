import { unzipSync, zipSync } from "fflate";
import { asBytes, assert, fail } from "./errors.mjs";
import { limitsWith } from "./limits.mjs";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(view) {
  const start = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= start; offset--) {
    if (u32(view, offset) === EOCD && offset + 22 + u16(view, offset + 20) === view.byteLength) return offset;
  }
  fail("ZIP_EOCD_INVALID", "ZIP end record is missing or malformed");
}

export function safeZipPath(raw) {
  assert(typeof raw === "string" && raw.length > 0 && raw.length <= 1024, "ZIP_PATH_INVALID", "Invalid ZIP path");
  assert(!raw.includes("\\") && !raw.includes("\0"), "ZIP_PATH_INVALID", "Backslash and NUL are forbidden in ZIP paths");
  assert(!raw.startsWith("/") && !/^[a-zA-Z]:/.test(raw), "ZIP_PATH_INVALID", "Absolute ZIP path is forbidden");
  const directory = raw.endsWith("/");
  const parts = raw.split("/");
  if (directory) parts.pop();
  assert(parts.length > 0 && parts.every((part) => part && part !== "." && part !== ".."), "ZIP_PATH_INVALID", "ZIP traversal is forbidden");
  assert(parts.every((part) => !Object.hasOwn(Object.prototype, part)), "ZIP_PATH_INVALID", "Dangerous ZIP path segment is forbidden");
  return `${parts.join("/")}${directory ? "/" : ""}`;
}

export function preflightZip(input, overrides = {}) {
  const bytes = asBytes(input, "ZIP_INVALID");
  const limits = limitsWith(overrides);
  assert(bytes.byteLength <= limits.archiveBytes, "ZIP_ARCHIVE_TOO_LARGE", "ZIP archive exceeds limit");
  assert(bytes.byteLength >= 22, "ZIP_INVALID", "ZIP archive is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  const disk = u16(view, eocd + 4);
  const centralDisk = u16(view, eocd + 6);
  const diskEntries = u16(view, eocd + 8);
  const entryCount = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  assert(disk === 0 && centralDisk === 0 && diskEntries === entryCount, "ZIP_MULTIDISK_FORBIDDEN", "Multi-disk ZIP is forbidden");
  assert(entryCount !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff, "ZIP64_FORBIDDEN", "ZIP64 is not supported");
  assert(entryCount <= limits.entries, "ZIP_TOO_MANY_ENTRIES", "ZIP entry count exceeds limit");
  assert(centralOffset + centralSize === eocd, "ZIP_CENTRAL_INVALID", "ZIP central directory is out of bounds");

  const entries = [];
  const names = new Set();
  const localOffsets = new Set();
  const localRanges = [];
  let expandedBytes = 0;
  let mediaExpandedBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    assert(offset + 46 <= eocd && u32(view, offset) === CENTRAL, "ZIP_CENTRAL_INVALID", "Malformed central directory entry");
    const madeBy = u16(view, offset + 4);
    const flags = u16(view, offset + 8);
    const method = u16(view, offset + 10);
    const crc32 = u32(view, offset + 16);
    const compressedSize = u32(view, offset + 20);
    const uncompressedSize = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const externalAttributes = u32(view, offset + 38);
    const localOffset = u32(view, offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    assert(end <= eocd, "ZIP_CENTRAL_INVALID", "Central directory entry exceeds bounds");
    assert((flags & 1) === 0, "ZIP_ENCRYPTED", "Encrypted ZIP entries are unsupported");
    assert(method === 0 || method === 8, "ZIP_COMPRESSION_UNSUPPORTED", "Only stored and deflate ZIP entries are supported");
    const allowedFlags = 0x0008 | 0x0800 | (method === 8 ? 0x0006 : 0);
    assert((flags & ~allowedFlags) === 0, "ZIP_FLAGS_UNSUPPORTED", "ZIP entry uses unsupported flags");
    assert(compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff && localOffset !== 0xffffffff, "ZIP64_FORBIDDEN", "ZIP64 entries are not supported");
    const host = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    assert(!(host === 3 && (unixMode & 0xf000) === 0xa000), "ZIP_LINK_FORBIDDEN", "ZIP symlink entries are forbidden");
    let name;
    try {
      name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      fail("ZIP_FILENAME_ENCODING", "ZIP entry name is not valid UTF-8");
    }
    name = safeZipPath(name);
    assert(!names.has(name), "ZIP_DUPLICATE_ENTRY", "Duplicate ZIP entry", { name });
    names.add(name);
    const isDirectory = name.endsWith("/");
    assert(!isDirectory || uncompressedSize === 0, "ZIP_DIRECTORY_INVALID", "ZIP directory entry contains data");
    const media = /(?:^|\/)(?:media|embeddings)\//i.test(name) || /\.(?:png|jpe?g|gif|webp|bmp|tiff?|emf|wmf|bin)$/i.test(name);
    const partLimit = media ? limits.mediaPartBytes : limits.partBytes;
    assert(uncompressedSize <= partLimit, "ZIP_PART_TOO_LARGE", "ZIP part exceeds limit", { name });
    if (uncompressedSize > 0) {
      assert(compressedSize > 0, "ZIP_RATIO_EXCEEDED", "Invalid zero-size compressed part", { name });
      assert(uncompressedSize / compressedSize <= limits.compressionRatio, "ZIP_RATIO_EXCEEDED", "ZIP compression ratio exceeds limit", { name });
    }
    expandedBytes += uncompressedSize;
    if (media) mediaExpandedBytes += uncompressedSize;
    assert(expandedBytes <= limits.expandedBytes, "ZIP_EXPANDED_TOO_LARGE", "ZIP expanded size exceeds limit");
    assert(mediaExpandedBytes <= limits.mediaExpandedBytes, "ZIP_MEDIA_TOO_LARGE", "ZIP media size exceeds limit");

    assert(!localOffsets.has(localOffset), "ZIP_LOCAL_OVERLAP", "ZIP entries share a local header", { name });
    localOffsets.add(localOffset);
    assert(localOffset + 30 <= centralOffset && u32(view, localOffset) === LOCAL, "ZIP_LOCAL_INVALID", "Malformed local ZIP entry", { name });
    const localFlags = u16(view, localOffset + 6);
    const localMethod = u16(view, localOffset + 8);
    const localCrc32 = u32(view, localOffset + 14);
    const localCompressedSize = u32(view, localOffset + 18);
    const localUncompressedSize = u32(view, localOffset + 22);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const localNameStart = localOffset + 30;
    const localDataStart = localNameStart + localNameLength + localExtraLength;
    const localDataEnd = localDataStart + compressedSize;
    assert(localDataEnd <= centralOffset, "ZIP_LOCAL_INVALID", "Local ZIP entry exceeds data bounds", { name });
    let localName;
    try {
      localName = decoder.decode(bytes.subarray(localNameStart, localNameStart + localNameLength));
    } catch {
      fail("ZIP_FILENAME_ENCODING", "Local ZIP entry name is not valid UTF-8");
    }
    assert(safeZipPath(localName) === name && localFlags === flags && localMethod === method, "ZIP_HEADER_MISMATCH", "Central/local ZIP headers differ", { name });
    let localEnd = localDataEnd;
    if ((flags & 0x0008) === 0) {
      assert(
        localCrc32 === crc32 && localCompressedSize === compressedSize && localUncompressedSize === uncompressedSize,
        "ZIP_HEADER_MISMATCH",
        "Central/local ZIP sizes or CRC differ",
        { name },
      );
    } else {
      assert(
        (localCrc32 === 0 || localCrc32 === crc32)
          && (localCompressedSize === 0 || localCompressedSize === compressedSize)
          && (localUncompressedSize === 0 || localUncompressedSize === uncompressedSize),
        "ZIP_HEADER_MISMATCH",
        "Local ZIP data-descriptor placeholders are invalid",
        { name },
      );
      const unsignedDescriptor = localDataEnd + 12 <= centralOffset
        && u32(view, localDataEnd) === crc32
        && u32(view, localDataEnd + 4) === compressedSize
        && u32(view, localDataEnd + 8) === uncompressedSize;
      const signedDescriptor = localDataEnd + 16 <= centralOffset
        && u32(view, localDataEnd) === DATA_DESCRIPTOR
        && u32(view, localDataEnd + 4) === crc32
        && u32(view, localDataEnd + 8) === compressedSize
        && u32(view, localDataEnd + 12) === uncompressedSize;
      assert(unsignedDescriptor || signedDescriptor, "ZIP_DATA_DESCRIPTOR_INVALID", "ZIP data descriptor differs from central directory", { name });
      localEnd = localDataEnd + (signedDescriptor ? 16 : 12);
    }
    localRanges.push({ start: localOffset, end: localEnd, name });
    entries.push(Object.freeze({ name, compressedSize, uncompressedSize, method, crc32, directory: isDirectory }));
    offset = end;
  }
  assert(offset === centralOffset + centralSize, "ZIP_CENTRAL_INVALID", "Central directory size mismatch");
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index++) {
    assert(localRanges[index - 1].end <= localRanges[index].start, "ZIP_LOCAL_OVERLAP", "ZIP local entry ranges overlap", {
      left: localRanges[index - 1].name,
      right: localRanges[index].name,
    });
  }
  return Object.freeze({ archiveBytes: bytes.byteLength, expandedBytes, mediaExpandedBytes, entries: Object.freeze(entries) });
}

export function safeUnzip(input, overrides = {}) {
  const bytes = asBytes(input, "ZIP_INVALID");
  const report = preflightZip(bytes, overrides);
  let unpacked;
  try {
    unpacked = unzipSync(bytes);
  } catch {
    fail("ZIP_DECOMPRESSION_FAILED", "ZIP decompression failed");
  }
  const allowedNames = new Set(report.entries.map((entry) => entry.name));
  for (const name of Object.keys(unpacked)) {
    assert(allowedNames.has(safeZipPath(name)), "ZIP_ENTRY_MISMATCH", "Decompressor returned an unknown ZIP entry", { name });
  }
  const files = new Map();
  for (const entry of report.entries) {
    if (entry.directory) continue;
    const value = unpacked[entry.name];
    assert(value instanceof Uint8Array && value.byteLength === entry.uncompressedSize, "ZIP_SIZE_MISMATCH", "Decompressed ZIP size differs", { name: entry.name });
    assert(crc32(value) === entry.crc32, "ZIP_CRC_MISMATCH", "Decompressed ZIP CRC differs", { name: entry.name });
    files.set(entry.name, value);
  }
  return { report, files };
}

export function makeZip(entries, options = {}) {
  const files = Object.create(null);
  for (const [name, value] of Object.entries(entries)) {
    const safeName = safeZipPath(name);
    assert(!safeName.endsWith("/"), "ZIP_PATH_INVALID", "Generated entry must be a file");
    assert(value instanceof Uint8Array, "INPUT_INVALID", "Generated ZIP entries must be Uint8Array");
    files[safeName] = value;
  }
  return zipSync(files, { level: options.level ?? 6, mtime: new Date(1980, 0, 1) });
}
