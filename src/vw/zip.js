// -----------------------------------------------------------------------------
// Minimal ZIP reader: the EU Data Act portal delivers each dataset as a ZIP
// archive holding one JSON document. Reads the local file headers (stored or
// deflated entries), no dependency.
// -----------------------------------------------------------------------------

import zlib from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;

/** The first `.json` entry of a ZIP archive, parsed. */
export function readJsonFromZip(buffer) {
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === LOCAL_HEADER) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    let size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    const hasDescriptor = (flags & 0x08) !== 0;
    if (hasDescriptor && size === 0) {
      // Streamed entry: the size follows the data, find the descriptor.
      let scan = start;
      while (scan + 4 <= buffer.length && buffer.readUInt32LE(scan) !== DATA_DESCRIPTOR) {
        scan += 1;
      }
      size = scan - start;
    }
    const data = buffer.subarray(start, start + size);
    if (name.toLowerCase().endsWith('.json')) {
      let raw;
      if (method === 0) {
        raw = data;
      } else if (method === 8) {
        raw = zlib.inflateRawSync(data);
      } else {
        throw new Error(`Unsupported ZIP compression method ${method}`);
      }
      return JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
    }
    offset = start + size;
    if (hasDescriptor) {
      offset += buffer.readUInt32LE(offset) === DATA_DESCRIPTOR ? 16 : 12;
    }
  }
  throw new Error('No JSON document in the dataset archive');
}
