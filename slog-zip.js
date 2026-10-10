// Zip files for the Scribe's Log: reading and writing the archives a log is
// merged into and the exports made for someone else to check, in plain
// JavaScript with no Node or browser APIs, so the same file runs in NEO, in
// scripts/, and inside the standalone verifier page.
//
// Only what the log needs: stored (0) and deflated (8) entries, UTF-8
// names, no zip64, no encryption. Deflating and inflating are handed in
// (Node's zlib in NEO; the browser's DecompressionStream in the verifier,
// which is unzip's default when nothing is handed in), so this file holds
// only the container: the headers, the central directory and CRC-32.

'use strict';

(function (exports) {
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: true }) : null;
  const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };

  const LOCAL = 0x04034b50;
  const CENTRAL = 0x02014b50;
  const END = 0x06054b50;
  const UTF8_FLAG = 0x0800;
  const MAX_ENTRIES = 65535;

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const u16 = (b, at) => b[at] | (b[at + 1] << 8);
  const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

  // A name as an entry may carry it: relative, forward slashes, no "." or
  // ".." segments, nothing absolute. Anything else is refused, so an
  // unpacked archive can't point outside where it's unpacked.
  function safeName(name) {
    if (typeof name !== 'string' || !name || name.length > 512) return false;
    if (/[\\\0]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
    return name.split('/').every((seg, i, all) => (seg ? seg !== '.' && seg !== '..' : i === all.length - 1));
  }

  // The end-of-central-directory record, searched for from the end (a
  // comment may follow it). `bytes` is the file's tail, starting at file
  // offset `tailAt`. Returns { count, size, offset } or throws.
  function findEnd(bytes, tailAt = 0) {
    for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
      if (u32(bytes, i) !== END) continue;
      const count = u16(bytes, i + 10);
      const size = u32(bytes, i + 12);
      const offset = u32(bytes, i + 16);
      if (u16(bytes, i + 4) || u16(bytes, i + 6) || u16(bytes, i + 8) !== count) throw new Error('a zip split across disks');
      if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('a zip64 file (not used by NEO)');
      if (offset + size > tailAt + i) throw new Error('the central directory runs past its end');
      return { count, size, offset, at: tailAt + i };
    }
    throw new Error('not a zip file');
  }

  // The central directory's entries: { name, method, flags, crc, csize,
  // usize, local } (local: the local header's offset in the file)
  function parseCentral(cd, count) {
    const entries = [];
    const seen = new Set();
    let at = 0;
    for (let k = 0; k < count; k++) {
      if (at + 46 > cd.length || u32(cd, at) !== CENTRAL) throw new Error('the central directory is damaged');
      const flags = u16(cd, at + 8);
      const nameLen = u16(cd, at + 28);
      const extraLen = u16(cd, at + 30);
      const commentLen = u16(cd, at + 32);
      if (at + 46 + nameLen > cd.length) throw new Error('the central directory is damaged');
      const raw = cd.subarray(at + 46, at + 46 + nameLen);
      let name;
      try { name = flags & UTF8_FLAG ? dec.decode(raw) : latin1(raw); } catch { throw new Error('an entry\'s name isn\'t UTF-8'); }
      if (flags & 1) throw new Error(name + ': encrypted');
      if (!safeName(name)) throw new Error('an entry has an unsafe name: ' + JSON.stringify(name.slice(0, 80)));
      if (seen.has(name)) throw new Error(name + ': in the zip twice');
      seen.add(name);
      entries.push({
        name, flags, method: u16(cd, at + 10), crc: u32(cd, at + 16),
        csize: u32(cd, at + 20), usize: u32(cd, at + 24), local: u32(cd, at + 42)
      });
      at += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  // Where an entry's data starts, from its local header (whose name and
  // extra field may differ in length from the central directory's)
  function dataStart(header, entry) {
    if (u32(header, 0) !== LOCAL) throw new Error(entry.name + ': its local header is missing');
    return entry.local + 30 + u16(header, 26) + u16(header, 28);
  }

  // A whole zip in memory: { entries } with each entry's `data` (its bytes
  // as stored, deflated or not). Directories (names ending "/") are left out.
  function parseZip(bytes) {
    const end = findEnd(bytes);
    const entries = parseCentral(bytes.subarray(end.offset, end.offset + end.size), end.count);
    const out = [];
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      if (e.local + 30 > end.offset) throw new Error(e.name + ': its data is outside the file');
      const start = dataStart(bytes.subarray(e.local, e.local + 30), e);
      if (start + e.csize > end.offset) throw new Error(e.name + ': its data runs past the central directory');
      out.push({ ...e, data: bytes.subarray(start, start + e.csize) });
    }
    return { entries: out };
  }

  // One entry's bytes, checked against its size and CRC-32
  function finish(e, bytes) {
    if (bytes.length !== e.usize) throw new Error(`${e.name}: unpacks to ${bytes.length} bytes, not ${e.usize}`);
    if (crc32(bytes) !== e.crc) throw new Error(e.name + ': its CRC-32 doesn\'t match');
    return bytes;
  }
  function method(e) {
    if (e.method !== 0 && e.method !== 8) throw new Error(`${e.name}: compression method ${e.method} isn't one NEO reads`);
    return e.method;
  }
  function entryBytesSync(e, inflateRawSync) {
    if (method(e) === 0) return finish(e, e.data);
    return finish(e, new Uint8Array(inflateRawSync(e.data)));
  }

  // The browser's own inflater (also in Node 18 and later)
  async function streamInflate(data) {
    if (typeof DecompressionStream === 'undefined') throw new Error('this browser can\'t unpack zip files (no DecompressionStream)');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Every file in a zip: { files: { name: Uint8Array }, problems }. A file
  // that won't unpack is a problem and is left out; a zip that can't be
  // read at all throws.
  function unzipSync(bytes, inflateRawSync) {
    const { entries } = parseZip(bytes);
    const files = {};
    const problems = [];
    for (const e of entries) {
      try { files[e.name] = entryBytesSync(e, inflateRawSync); } catch (err) { problems.push(err.message); }
    }
    return { files, problems };
  }
  // `only`: the names wanted (the rest aren't unpacked); `max`: the most
  // bytes one entry may unpack to, by what the zip says (a zip bomb is
  // refused before it's inflated; an inflater handed in should hold to
  // the same limit, since a zip can lie about its sizes)
  async function unzip(bytes, inflateRaw = streamInflate, { only = null, max = Infinity } = {}) {
    const { entries } = parseZip(bytes);
    const files = {};
    const problems = [];
    for (const e of entries) {
      if (only && !only.includes(e.name)) continue;
      if (e.usize > max) { problems.push(`${e.name}: too large to read (${e.usize} bytes)`); continue; }
      try {
        files[e.name] = method(e) === 0 ? finish(e, e.data) : finish(e, new Uint8Array(await inflateRaw(e.data)));
      } catch (err) { problems.push(err.message); }
    }
    return { files, problems };
  }

  // A zip of `files` ([{ name, data }], data as bytes or text), each
  // deflated with deflateRawSync when it's handed in and that's smaller,
  // stored otherwise. Every entry gets the same time (`time`, ms; DOS time
  // is local and to two seconds, so it's only a courtesy for whoever opens
  // the zip by hand: nothing in the log depends on it).
  function zip(files, { deflateRawSync = null, time = Date.now() } = {}) {
    if (files.length > MAX_ENTRIES) throw new Error('too many files for one zip');
    const d = new Date(time);
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const locals = [];
    const centrals = [];
    let offset = 0;
    const seen = new Set();
    for (const f of files) {
      if (!safeName(f.name) || f.name.endsWith('/')) throw new Error('not a name a zip entry can have: ' + f.name);
      if (seen.has(f.name)) throw new Error(f.name + ': twice in one zip');
      seen.add(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(f.data);
      const name = enc.encode(f.name);
      let stored = data;
      let m = 0;
      if (deflateRawSync && data.length > 64) {
        const z = new Uint8Array(deflateRawSync(data));
        if (z.length < data.length) { stored = z; m = 8; }
      }
      const crc = crc32(data);
      if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('too big for a zip without zip64');
      const head = new Uint8Array(30 + name.length);
      const hv = new DataView(head.buffer);
      hv.setUint32(0, LOCAL, true); hv.setUint16(4, 20, true); hv.setUint16(6, UTF8_FLAG, true); hv.setUint16(8, m, true);
      hv.setUint16(10, dosTime, true); hv.setUint16(12, dosDate, true); hv.setUint32(14, crc, true);
      hv.setUint32(18, stored.length, true); hv.setUint32(22, data.length, true); hv.setUint16(26, name.length, true);
      head.set(name, 30);
      const cen = new Uint8Array(46 + name.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, CENTRAL, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, UTF8_FLAG, true);
      cv.setUint16(10, m, true); cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, stored.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cen.set(name, 46);
      locals.push(head, stored);
      centrals.push(cen);
      offset += head.length + stored.length;
    }
    const cdSize = centrals.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, END, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cdSize + 22);
    let at = 0;
    for (const p of [...locals, ...centrals, end]) { out.set(p, at); at += p.length; }
    return out;
  }

  Object.assign(exports, { crc32, safeName, findEnd, parseCentral, dataStart, parseZip, entryBytesSync, unzipSync, unzip, streamInflate, zip });
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.SlogZip = {}));
