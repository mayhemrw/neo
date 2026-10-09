'use strict';

// An editor's changes in the Scribe's Log (phase 6, decision 2): text the
// writer accepted from a Word review is logged as `src: "editor"` with the
// book's own number for the reviewer (`by: "Reviewer 1"`), never a name.
// The checker, the report, playback and the verifier carry it through.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const slog = require('../slog.js');
const V = require('../slog-verify.js');
const R = require('../slog-report.js');
const P = require('../slog-playback.js');
const RM = require('../review-match.js');
const C = require('../verifier/check.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-slog-editor-'));

function setup() {
  const dir = path.join(tmpRoot, 'book-a');
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  const meta = { id: 'book-a', title: 'A Book', author: 'Ada', chapterOrder: ['ch-1'] };
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, 'chapters', 'ch-1.html'), '');
  let clock = Date.UTC(2026, 9, 9, 16, 0, 0);
  const rec = new slog.Recorder({ home: path.join(tmpRoot, 'home'), app: 'test', now: () => (clock += 1000) });
  const save = (html, how) => {
    rec.observe(dir, 'book-a', 'ch-1', html, how);
    rec.touch(dir, 'book-a');
    fs.writeFileSync(path.join(dir, 'chapters', 'ch-1.html'), html);
    rec.wrote(dir, 'book-a', 'ch-1', html);
  };
  return { dir, rec, save };
}
const TYPED = 'The harbor was quiet before the storm came in';
const EDITED = 'and the boats rode at anchor';

describe('the log: an editor\'s text', { concurrency: 1 }, () => {
  test('the window\'s label keeps the reviewer\'s number, never a name', () => {
    assert.deepEqual(slog.cleanLabel({ src: 'editor', by: 'Reviewer 2', cause: 'review' }), { src: 'editor', cause: 'review', by: 'Reviewer 2' });
    assert.deepEqual(slog.cleanLabel({ src: 'editor', by: 'Dana Editor', cause: 'review' }), { src: 'editor', cause: 'review' });
    assert.deepEqual(slog.cleanLabel({ src: 'typed', by: 'Reviewer 1' }), { src: 'typed' });
    assert.deepEqual(slog.cleanLabel({ src: 'editor', by: 'Reviewer 0' }), { src: 'editor' });
  });

  test('accepted text is the editor\'s in the log, the checker, the report and playback', async () => {
    const { dir, rec, save } = setup();
    rec.open(dir, 'book-a');
    save(`<p>${TYPED}.</p>`, { src: 'typed', dur: 2000, ev: 12 });
    save(`<p>${TYPED}, ${EDITED}.</p>`, { src: 'editor', by: 'Reviewer 1', cause: 'review' });
    // a deletion the editor asked for, accepted
    save(`<p>${TYPED.replace(' quiet', '')}, ${EDITED}.</p>`, { src: 'editor', by: 'Reviewer 1', cause: 'review' });
    await rec.close('book-a');

    const files = {};
    const logDir = path.join(dir, slog.LOG_DIR);
    for (const n of fs.readdirSync(logDir)) if (fs.statSync(path.join(logDir, n)).isFile()) files[n] = fs.readFileSync(path.join(logDir, n), 'utf8');
    const entries = Object.keys(files).filter(slog.isChunkName).sort().flatMap((n) => slog.parseChunk(files[n]).entries);
    const ed = entries.filter((e) => e.src === 'editor');
    assert.equal(ed.length, 2);
    assert.ok(ed.every((e) => e.by === 'Reviewer 1' && e.cause === 'review'));
    assert.ok(!JSON.stringify(entries).includes('Dana'));
    assert.ok(!entries.some((e) => e.src === 'unlogged'));

    const res = await V.checkLog(files);
    assert.equal(res.ok, true, JSON.stringify(res.problems));
    const made = res.devices[0].made;
    assert.equal(made['editor:Reviewer 1'], (', ' + EDITED).length);
    assert.equal(made.typed, `${TYPED}.`.length - ' quiet'.length);

    const stats = R.reportStats(res, {});
    assert.equal(stats.counts['editor:Reviewer 1'], (', ' + EDITED).length);
    const page = R.renderReport(stats, { privacy: 'dates', tz: 'UTC' });
    assert.ok(page.includes('From an editor (Reviewer 1)'));
    assert.ok(!page.includes('Dana'));
    // named only when the writer asks, in that report alone
    const named = R.renderReport(stats, { privacy: 'dates', tz: 'UTC', editorNames: RM.reviewerNames([{ name: 'Dana', num: 1 }]) });
    assert.ok(named.includes('From an editor (Dana)'));

    // the verifier's summary says so
    const sum = C.summarize({ kind: 'folder', res, stats, manifest: null, exportProblems: [] });
    const item = sum.find((x) => x.key === 'editors');
    assert.ok(item && /an editor's changes/.test(item.title), JSON.stringify(sum.map((x) => x.key)));

    // playback: the step says whose it was, and the text is colored as an editor's
    const chains = res.devices.map((d) => ({ dev: d.dev, entries: d.entries }));
    const pb = P.build(chains, 'ch-1');
    const steps = pb.steps.filter((s) => s.src === 'editor');
    assert.equal(steps.length, 2);
    assert.equal(P.stepLabel(steps[0], true, (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s)), 'From an editor (Reviewer 1)');
    assert.ok(P.ORIGINS.includes('editor'));
  });

  test('review.json numbers reviewers in the order they first came', () => {
    const list = [];
    list.push({ name: 'Dana', num: RM.nextNum(list) });
    list.push({ name: 'Sam', num: RM.nextNum(list) });
    assert.equal(RM.reviewerTag(list, 'Sam'), 'Reviewer 2');
    assert.equal(RM.reviewerTag(list, 'Nobody'), null);
    assert.deepEqual(RM.reviewerNames(list), { 'Reviewer 1': 'Dana', 'Reviewer 2': 'Sam' });
    // an older file without numbers: by place
    assert.equal(RM.reviewerTag([{ name: 'A' }, { name: 'B' }], 'B'), 'Reviewer 2');
  });
});
