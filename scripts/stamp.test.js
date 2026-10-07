'use strict';

// Outside timestamps (phase 2, milestone 1): the hash module, OpenTimestamps
// proofs and calendars, RFC 3161 tokens. Real receipts from FreeTSA and the
// OpenTimestamps calendars are fixtures (scripts/fixtures/stamps, see its
// README), so nothing here touches the network; scripts/stamp-live.js does.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const H = require('../slog-hash.js');
const ots = require('../stamp-ots.js');
const tsa = require('../stamp-tsa.js');

const FIX = path.join(__dirname, 'fixtures', 'stamps');
const fix = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
const fixText = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').trim();
const pem = (file) => tsa.pemToDer(fs.readFileSync(file, 'utf8'));
const FREETSA_ROOT = pem(path.join(__dirname, '..', 'certs', 'freetsa-root.pem'));
const FREETSA_TSA = pem(path.join(__dirname, '..', 'certs', 'freetsa-tsa.pem'));

// A fake network: routes are [method, url pattern, handler(url, init)]
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url });
    for (const [m, re, fn] of routes) {
      if (m === method && re.test(url)) return fn(url, init);
    }
    return answer(404, new Uint8Array(0));
  };
  f.calls = calls;
  return f;
}
function answer(status, body) {
  const bytes = typeof body === 'string' ? H.utf8(body) : body;
  return { status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), text: async () => H.fromUtf8(bytes) };
}

describe('hashes in plain JavaScript', () => {
  test('agree with Node\'s', () => {
    for (let n = 0; n < 200; n++) {
      const b = new Uint8Array(crypto.randomBytes((n * 37) % 700));
      assert.equal(H.toHex(H.sha256(b)), crypto.createHash('sha256').update(b).digest('hex'));
      assert.equal(H.toHex(H.sha1(b)), crypto.createHash('sha1').update(b).digest('hex'));
      assert.equal(H.toHex(H.ripemd160(b)), crypto.createHash('ripemd160').update(b).digest('hex'));
      const k = new Uint8Array(crypto.randomBytes(n % 90));
      assert.equal(H.toHex(H.hmacSha256(k, b)), crypto.createHmac('sha256', k).update(b).digest('hex'));
    }
  });
  test('hex and UTF-8 go both ways', () => {
    assert.equal(H.toHex(H.fromHex('00ff10ab')), '00ff10ab');
    assert.equal(H.fromUtf8(H.utf8('Mara’s boat')), 'Mara’s boat');
    assert.throws(() => H.fromHex('abc'));
    assert.ok(H.compare(H.fromHex('01'), H.fromHex('0100')) < 0);
  });
});

describe('OpenTimestamps proofs', () => {
  const files = ['hello-world.txt.ots', 'merkle1.txt.ots', 'neo-pending.ots'];
  test('read and written back byte for byte (python-opentimestamps\' order)', () => {
    for (const f of files) {
      const b = fix(f);
      assert.ok(H.equal(ots.serialize(ots.parse(b)), b), f);
    }
  });
  test('a finished proof names its Bitcoin block and merkle root', () => {
    const p = ots.parse(fix('hello-world.txt.ots'));
    const c = ots.check(p, H.sha256(fix('hello-world.txt')));
    assert.equal(c.ok, true);
    assert.deepEqual(c.pending, []);
    assert.equal(c.bitcoin.length, 1);
    assert.equal(c.bitcoin[0].height, 358391);
    assert.equal(c.bitcoin[0].root, '8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00');
    assert.deepEqual(ots.check(p, H.sha256(H.utf8('something else'))).problems, ['the proof is for a different hash']);
  });
  test('a pending proof names its calendars', () => {
    const c = ots.check(ots.parse(fix('neo-pending.ots')), fixText('neo-pending.hash'));
    assert.equal(c.ok, true);
    assert.deepEqual(c.pending.slice().sort(), [
      'https://alice.btc.calendar.opentimestamps.org', 'https://bob.btc.calendar.opentimestamps.org',
      'https://btc.calendar.catallaxy.com', 'https://finney.calendar.eternitywall.com'
    ]);
  });
  test('the block header has to be the block\'s and hold the attested root', () => {
    const [id, hdr] = fixText('block-358391.txt').split('\n');
    const att = ots.check(ots.parse(fix('hello-world.txt.ots'))).bitcoin[0];
    const ok = ots.headerMatches(hdr, id, att);
    assert.equal(ok.ok, true);
    assert.equal(new Date(ok.time).toISOString(), '2015-05-28T15:41:18.000Z');
    const forged = hdr.slice(0, 80) + 'ff' + hdr.slice(82);
    assert.equal(ots.headerMatches(forged, id, att).error, 'the header isn\'t the block\'s');
    assert.equal(ots.headerMatches(hdr, id, { ...att, msg: '00'.repeat(32) }).error, 'the block\'s merkle root isn\'t the one attested');
  });
  test('checkBlock asks an explorer, and the next when one fails', async () => {
    const [id, hdr] = fixText('block-358391.txt').split('\n');
    const att = ots.check(ots.parse(fix('hello-world.txt.ots'))).bitcoin[0];
    const f = fakeFetch([
      ['GET', /^https:\/\/mempool\.space\//, () => answer(503, 'busy')],
      ['GET', /blockstream\.info\/api\/block-height\/358391$/, () => answer(200, id)],
      ['GET', /blockstream\.info\/api\/block\/0+3e89.*\/header$/, () => answer(200, hdr)]
    ]);
    const res = await ots.checkBlock(f, att);
    assert.equal(res.ok, true);
    assert.equal(res.source, 'https://blockstream.info/api');
    // an explorer that hands back some other block's header
    const liar = fakeFetch([
      ['GET', /block-height/, () => answer(200, id)],
      ['GET', /header$/, () => answer(200, hdr.replace(/^02/, '03'))]
    ]);
    assert.equal((await ots.checkBlock(liar, att, { explorers: ['https://x.test/api'] })).ok, false);
  });

  // a calendar that answers a submitted digest with a pending attestation
  function calendarNamed(name) {
    return (url, init) => {
      const msg = new Uint8Array(init.body);
      const n = ots.node(msg);
      const tip = n; // calendars add their own ops; one append stands in for them
      const c = { op: { tag: 0xf0, arg: H.utf8(name) }, stamp: ots.node(H.concat(msg, H.utf8(name))) };
      c.stamp.attestations.push({ type: 'pending', uri: `https://${name}.btc.calendar.opentimestamps.org` });
      tip.ops.push(c);
      return answer(200, ots.serializeTimestamp(n));
    };
  }
  test('a stamp: digest, nonce appended, hashed, sent; done once two answer', async () => {
    const digest = H.sha256(H.utf8('entry 1205'));
    const nonce = new Uint8Array(16).fill(7);
    const f = fakeFetch([
      ['POST', /a\.pool\.opentimestamps\.org\/digest$/, calendarNamed('alice')],
      ['POST', /b\.pool\.opentimestamps\.org\/digest$/, calendarNamed('bob')],
      ['POST', /eternitywall/, () => answer(500, 'down')]
    ]);
    const res = await ots.stamp(f, digest, { nonce });
    assert.deepEqual(res.answered.sort(), ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org']);
    assert.equal(res.failed.length, 2);
    // what the calendars saw: sha256(digest ‖ nonce), never the digest
    const sent = f.calls.filter((c) => c.method === 'POST');
    assert.equal(sent.length, 4);
    const b = ots.serialize(res.file);
    const back = ots.parse(b);
    assert.ok(H.equal(back.digest, digest));
    const [first] = back.timestamp.ops;
    assert.equal(first.op.tag, 0xf0);
    assert.ok(H.equal(first.op.arg, nonce));
    assert.ok(H.equal(first.stamp.ops[0].stamp.msg, H.sha256(H.concat(digest, nonce))));
    assert.equal(ots.check(back, digest).pending.length, 2);
    // only one answer: not enough
    const lonely = fakeFetch([['POST', /a\.pool\.opentimestamps/, calendarNamed('alice')]]);
    assert.equal((await ots.stamp(lonely, digest)).file, null);
  });
  test('upgrade: the finished proof is added; a calendar not yet done waits; strangers aren\'t asked', async () => {
    const digest = H.sha256(H.utf8('entry 1290'));
    const made = await ots.stamp(fakeFetch([
      ['POST', /a\.pool/, calendarNamed('alice')],
      ['POST', /b\.pool/, calendarNamed('bob')]
    ]), digest);
    // a proof also naming a calendar that isn't on the list
    const commit = made.file.timestamp.ops[0].stamp.ops[0].stamp;
    const evil = { op: { tag: 0xf0, arg: H.utf8('x') }, stamp: ots.node(H.concat(commit.msg, H.utf8('x'))) };
    evil.stamp.attestations.push({ type: 'pending', uri: 'https://evil.example.com' });
    commit.ops.push(evil);
    const f = fakeFetch([
      ['GET', /alice\.btc\.calendar\.opentimestamps\.org\/timestamp\/[0-9a-f]+$/, (url) => {
        const msg = H.fromHex(url.split('/').pop());
        const n = ots.node(msg);
        const c = { op: { tag: 0x08 }, stamp: ots.node(H.sha256(msg)) };
        c.stamp.attestations.push({ type: 'bitcoin', height: 900001 });
        n.ops.push(c);
        return answer(200, ots.serializeTimestamp(n));
      }],
      ['GET', /bob\.btc/, () => answer(404, 'Pending confirmation in Bitcoin blockchain')]
    ]);
    const up = await ots.upgrade(f, made.file);
    assert.deepEqual(up.upgraded, ['https://alice.btc.calendar.opentimestamps.org']);
    assert.deepEqual(up.waiting, ['https://bob.btc.calendar.opentimestamps.org']);
    assert.deepEqual(up.failed, [{ uri: 'https://evil.example.com', error: 'not a known calendar' }]);
    assert.ok(!f.calls.some((c) => c.url.includes('evil')));
    const c = ots.check(ots.parse(ots.serialize(up.file)), digest);
    assert.deepEqual(c.bitcoin.map((x) => x.height), [900001]);
  });
  test('the calendar list: https, known hosts, nothing else', () => {
    assert.ok(ots.allowedCalendar('https://alice.btc.calendar.opentimestamps.org'));
    assert.ok(ots.allowedCalendar('https://btc.calendar.catallaxy.com'));
    for (const u of ['http://alice.btc.calendar.opentimestamps.org', 'https://calendar.opentimestamps.org', 'https://alice.btc.calendar.opentimestamps.org.evil.com',
      'https://alice.btc.calendar.opentimestamps.org:8443', 'https://alice.btc.calendar.opentimestamps.org/x', 'https://a@alice.btc.calendar.opentimestamps.org']) {
      assert.equal(ots.allowedCalendar(u), false, u);
    }
  });
  test('a hostile proof is refused, not followed', () => {
    const good = fix('hello-world.txt.ots');
    const head = good.slice(0, ots.MAGIC.length + 1 + 1 + 32); // magic, version, sha256, digest
    assert.throws(() => ots.parse(good.slice(0, good.length - 3)), /ends too soon/);
    assert.throws(() => ots.parse(H.concat(good, Uint8Array.of(0))), /left over/);
    assert.throws(() => ots.parse(H.concat(Uint8Array.of(1), good.slice(1))), /not an OpenTimestamps proof/);
    assert.throws(() => ots.parse(H.concat(head, Uint8Array.of(0x55))), /unknown operation/);
    // reverse, reverse, … 300 deep: past the nesting limit
    const deep = H.concat(head, new Uint8Array(300).fill(0xf2), Uint8Array.of(0x00), H.fromHex('0588960d73d71901'), Uint8Array.of(1, 1));
    assert.throws(() => ots.parse(deep), /nests too deep/);
    // an append that would make a message past the length limit
    const big = H.concat(head, Uint8Array.of(0xf0), Uint8Array.of(0xa0, 0x1f), new Uint8Array(4000), Uint8Array.of(0xf0, 0xa0, 0x1f), new Uint8Array(4000), Uint8Array.of(0x00), H.fromHex('0588960d73d71901'), Uint8Array.of(1, 1));
    assert.throws(() => ots.parse(big), /too long/);
  });
});

describe('RFC 3161 tokens', () => {
  const freetsa = (name) => tsa.parseResponse(fix(name)).token;
  const FREETSA_HASH = fixText('freetsa.hash');
  test('a request: version 1, SHA-256, the hash, a nonce, and certReq when asked', () => {
    const hash = H.sha256(H.utf8('entry'));
    const { der, nonce } = tsa.request(hash, { nonce: H.fromHex('0081a2'), certReq: true });
    const { read, kids, oid } = tsa.der;
    const k = kids(der, read(der));
    assert.equal(der[k[0].cs], 1);
    const imp = kids(der, k[1]);
    assert.equal(oid(der, kids(der, imp[0])[0]), tsa.OID.sha256);
    assert.ok(H.equal(der.slice(imp[1].cs, imp[1].end), hash));
    assert.equal(nonce, '81a2');
    assert.equal(H.toHex(der.slice(k[2].cs, k[2].end)), '0081a2', 'a nonce with its top bit set is kept positive');
    assert.equal(k[3].tag, 0x01);
    assert.equal(tsa.request(hash, { nonce: H.fromHex('0081a2') }).der.length, der.length - 3, 'no certReq unless asked');
    assert.equal(tsa.request(hash).nonce.length <= 16, true, 'a random 8-byte nonce by default');
    assert.throws(() => tsa.request(new Uint8Array(20)));
  });
  test('FreeTSA\'s token verifies to its root, with the time it says', async () => {
    const v = await tsa.verify(freetsa('freetsa-with-certs.tsr'), { hash: FREETSA_HASH, anchors: [FREETSA_ROOT] });
    assert.deepEqual(v.problems, []);
    assert.equal(v.ok, true);
    assert.equal(new Date(v.time).toISOString(), '2026-10-07T22:01:45.000Z');
    assert.equal(v.tst.nonce, 'b38302a9e8d94c08');
    assert.equal(v.chain.length, 2);
  });
  test('a token without certificates verifies with the signing certificate kept beside it', async () => {
    const token = freetsa('freetsa.tsr');
    assert.ok(token.length < 1000);
    const bare = await tsa.verify(token, { hash: FREETSA_HASH, anchors: [FREETSA_ROOT] });
    assert.deepEqual(bare.problems, ['the signer\'s certificate isn\'t in hand']);
    const v = await tsa.verify(token, { hash: FREETSA_HASH, anchors: [FREETSA_ROOT], certs: [FREETSA_TSA] });
    assert.deepEqual(v.problems, []);
  });
  test('RSA and P-256 authorities (signing-certificate v2) verify too', async () => {
    const hash = fixText('local.hash');
    for (const k of ['rsa', 'p256']) {
      const token = tsa.parseResponse(fix(`local-${k}.tsr`)).token;
      const root = pem(path.join(FIX, `local-${k}-root.pem`));
      const v = await tsa.verify(token, { hash, anchors: [root] });
      assert.deepEqual(v.problems, [], k);
      const other = pem(path.join(FIX, `local-${k === 'rsa' ? 'p256' : 'rsa'}-root.pem`));
      assert.ok((await tsa.verify(token, { hash, anchors: [other] })).problems.includes('the chain doesn\'t reach a trusted root'), k);
    }
  });
  test('a wrong hash, a wrong nonce, or an untrusted root is caught', async () => {
    const token = freetsa('freetsa-with-certs.tsr');
    const wrong = await tsa.verify(token, { hash: '00'.repeat(32), anchors: [FREETSA_ROOT] });
    assert.deepEqual(wrong.problems, ['the token is for a different hash']);
    const nonce = await tsa.verify(token, { hash: FREETSA_HASH, anchors: [FREETSA_ROOT], nonce: '01' });
    assert.deepEqual(nonce.problems, ['the token\'s nonce isn\'t the request\'s']);
    const noRoot = await tsa.verify(token, { hash: FREETSA_HASH, anchors: [] });
    assert.ok(noRoot.problems.includes('the chain doesn\'t reach a trusted root'));
  });
  test('a tampered token doesn\'t verify', async () => {
    const token = freetsa('freetsa-with-certs.tsr');
    const { eContent, signer } = tsa.parseToken(token);
    // the timestamp itself (its last byte: inside the TSA's name)
    const at = indexOf(token, eContent) + eContent.length - 1;
    const t1 = token.slice(); t1[at] ^= 1;
    assert.ok((await tsa.verify(t1, { hash: FREETSA_HASH, anchors: [FREETSA_ROOT] })).problems.includes('the signed digest doesn\'t match the timestamp'));
    // the signature
    const s = indexOf(token, signer.sig) + 20;
    const t2 = token.slice(); t2[s] ^= 1;
    assert.ok((await tsa.verify(t2, { hash: FREETSA_HASH, anchors: [FREETSA_ROOT] })).problems.includes('the signature doesn\'t verify'));
    // the signing certificate's own signature (its last byte)
    const cert = tsa.parseToken(token).certs.find((c) => tsa.parseCert(c).cn === 'www.freetsa.org' && !tsa.parseCert(c).ca);
    const c = indexOf(token, cert) + cert.length - 1;
    const t3 = token.slice(); t3[c] ^= 1;
    const v3 = await tsa.verify(t3, { hash: FREETSA_HASH, anchors: [FREETSA_ROOT] });
    assert.equal(v3.ok, false);
    // garbage
    assert.equal((await tsa.verify(token.slice(0, 100), {})).ok, false);
  });
  test('stamp: a refusal, a token for another hash, a nonce that isn\'t ours', async () => {
    const hash = H.fromHex(FREETSA_HASH);
    const refuse = fakeFetch([['POST', /tsr$/, () => answer(200, H.fromHex('3005300302010 2'.replace(/ /g, '')))]]);
    await assert.rejects(tsa.stamp(refuse, 'https://tsa.test/tsr', hash), /refused: rejection/);
    const down = fakeFetch([['POST', /tsr$/, () => answer(503, 'busy')]]);
    await assert.rejects(tsa.stamp(down, 'https://tsa.test/tsr', hash), /answered 503/);
    const old = fakeFetch([['POST', /tsr$/, () => answer(200, fix('freetsa.tsr'))]]);
    await assert.rejects(tsa.stamp(old, 'https://tsa.test/tsr', H.sha256(H.utf8('other'))), /different hash/);
    await assert.rejects(tsa.stamp(old, 'https://tsa.test/tsr', hash), /nonce/);
  });
  test('certificates read: FreeTSA\'s signer is for timestamping, its root a CA', () => {
    const signer = tsa.parseCert(FREETSA_TSA);
    assert.deepEqual(signer.eku, [tsa.OID.timeStamping]);
    assert.equal(signer.ekuCritical, true);
    assert.equal(signer.curve, tsa.OID.p384);
    const root = tsa.parseCert(FREETSA_ROOT);
    assert.equal(root.ca, true);
    assert.equal(new Date(root.notAfter).toISOString(), '2041-03-07T01:52:13.000Z');
  });
});

function indexOf(hay, needle) {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let j = 0;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}
