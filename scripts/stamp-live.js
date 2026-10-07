#!/usr/bin/env node
// Tries the real services, for development (npm test never touches the
// network):
//
//   node scripts/stamp-live.js [folder]
//
// Stamps a random hash with FreeTSA and the OpenTimestamps calendars,
// verifies the FreeTSA token against certs/, checks the fixture's old
// Bitcoin attestation against the block explorers, and upgrades any
// pending proofs saved in [folder] by earlier runs (written there as
// <hash>.ots), checking each finished one against its block. Behind a
// proxy, Node's fetch needs NODE_USE_ENV_PROXY=1.

'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../slog-hash.js');
const ots = require('../stamp-ots.js');
const tsa = require('../stamp-tsa.js');

const ROOT = path.join(__dirname, '..');
const pem = (f) => tsa.pemToDer(fs.readFileSync(path.join(ROOT, f), 'utf8'));

async function main() {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const hash = new Uint8Array(32);
  crypto.getRandomValues(hash);
  console.log('hash', H.toHex(hash));

  // FreeTSA
  try {
    const sent = Date.now();
    const got = await tsa.stamp(fetch, 'https://freetsa.org/tsr', hash);
    const v = await tsa.verify(got.token, { hash, anchors: [pem('certs/freetsa-root.pem')], certs: [pem('certs/freetsa-tsa.pem')], nonce: got.nonce });
    console.log(`FreeTSA: ${v.ok ? 'verified' : 'NOT verified ' + JSON.stringify(v.problems)}, ${got.token.length} bytes, time ${new Date(v.time).toISOString()} (${Math.round((v.time - sent) / 1000)} s from this clock)`);
  } catch (err) {
    console.log('FreeTSA: failed:', err.message);
  }

  // OpenTimestamps calendars
  const st = await ots.stamp(fetch, hash);
  console.log(`calendars: ${st.answered.length} answered${st.failed.length ? ', failed: ' + st.failed.map((f) => f.url + ' (' + f.error + ')').join('; ') : ''}`);
  if (st.file) {
    const b = ots.serialize(st.file);
    console.log(`  pending at ${ots.check(st.file, hash).pending.join(', ')} (${b.length} bytes)`);
    if (dir) fs.writeFileSync(path.join(dir, H.toHex(hash) + '.ots'), b);
  }

  // an old attestation against the explorers
  const hello = ots.parse(new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'stamps', 'hello-world.txt.ots'))));
  const att = ots.check(hello).bitcoin[0];
  const blk = await ots.checkBlock(fetch, att);
  console.log(`block ${att.height}: ${blk.ok ? 'matches, mined ' + new Date(blk.time).toISOString() + ' (' + blk.source + ')' : 'NOT checked: ' + blk.error}`);

  // earlier runs' proofs
  if (dir) {
    for (const name of fs.readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.ots$/.test(f))) {
      const file = ots.parse(new Uint8Array(fs.readFileSync(path.join(dir, name))));
      const before = ots.check(file);
      if (before.bitcoin.length) { console.log(`${name}: already finished`); continue; }
      const up = await ots.upgrade(fetch, file);
      const after = ots.check(up.file, name.slice(0, 64));
      console.log(`${name}: upgraded ${up.upgraded.length}, waiting ${up.waiting.length}${up.failed.length ? ', failed ' + JSON.stringify(up.failed) : ''}`);
      if (up.upgraded.length) fs.writeFileSync(path.join(dir, name), ots.serialize(up.file));
      for (const a of after.bitcoin) {
        const c = await ots.checkBlock(fetch, a);
        console.log(`  block ${a.height}: ${c.ok ? 'matches, mined ' + new Date(c.time).toISOString() : 'NOT checked: ' + c.error}`);
      }
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
