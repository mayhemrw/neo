'use strict';

// The guides (docs/HOW-TO.md and docs/FAQ.md) and guide.js, which shows
// them in NEO: the Markdown they use turned into markup with every word
// escaped, links between them, and every menu name they mention found in
// main.js's menus. guide.e2e.js checks those names against the real menu
// and opens the guides from it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const G = require('../guide.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('headings, paragraphs, lists and a step\'s bullets', () => {
  const { html, toc } = G.render('# Title\n\nSome words\ncarried on.\n\n## Do it\n\n1. First **bold** step.\n2. Second:\n   - one\n   - two\n3. Third\n   carried on.\n\n- a\n- b\n');
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<p>Some words carried on\.<\/p>/);
  assert.match(html, /<ol><li>First <strong>bold<\/strong> step\.<\/li><li>Second:<ul><li>one<\/li><li>two<\/li><\/ul><\/li><li>Third carried on\.<\/li><\/ol>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.deepEqual(toc, [{ level: 1, text: 'Title', id: 'title' }, { level: 2, text: 'Do it', id: 'do-it' }]);
});

test('every word is escaped: a guide can\'t put markup on the page', () => {
  const { html } = G.render('## <img src=x onerror=alert(1)>\n\nA <script>x</script> & "q" `<b>`\n\n[click](javascript:void0) [web](https://example.com)');
  assert.ok(!/<img|<script|<b>|href="javascript|example\.com/.test(html), html);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt; &amp; &quot;q&quot; <code>&lt;b&gt;<\/code>/);
  assert.match(html, /<p>click web<\/p>/, 'other links are plain text');
});

test('links to the other guide and to a heading are marks the window follows', () => {
  assert.equal(G.inline('[FAQ](FAQ.md)'), '<a href="#" data-guide="faq">FAQ</a>');
  assert.equal(G.inline('[how](HOW-TO.md#find-these-guides-again)'), '<a href="#" data-guide="how-to" data-anchor="find-these-guides-again">how</a>');
  assert.equal(G.inline('[up](#prove-you-wrote-your-book)'), '<a href="#" data-anchor="prove-you-wrote-your-book">up</a>');
  assert.equal(G.inline('*a* and `x*y*`'), '<em>a</em> and <code>x*y*</code>');
});

test('the same heading twice gets two ids', () => {
  const { toc } = G.render('## Same\n\n## Same\n');
  assert.deepEqual(toc.map((h) => h.id), ['same', 'same-2']);
});

test('menu paths are read from bold text', () => {
  assert.deepEqual(G.menuPaths('Choose **File → Scribe\'s Log → Verification Report…** and **Save Report…**, or **View → Review**.'),
    [['File', 'Scribe\'s Log', 'Verification Report…'], ['View', 'Review']]);
});

// every label buildMenu gives an item, as written in main.js
function menuLabels() {
  const src = read('main.js');
  const body = src.slice(src.indexOf('function buildMenu()'), src.indexOf('const menu = Menu.buildFromTemplate(template);'));
  const labels = new Set();
  const re = /label: (?:isMac \? t\('(?:[^'\\]|\\.)*'\) : )?(?:t\()?'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body))) labels.add(m[1].replace(/\\'/g, '\''));
  return labels;
}

for (const file of ['docs/HOW-TO.md', 'docs/FAQ.md']) {
  test(`${file}: every menu name it gives is one of NEO's`, () => {
    const md = read(file);
    const paths = G.menuPaths(md);
    assert.ok(paths.length >= 10, `${paths.length} menu paths`);
    const labels = menuLabels();
    for (const p of paths) for (const name of p) assert.ok(labels.has(name), `${p.join(' → ')}: no menu item “${name}”`);
  });
  test(`${file}: reads whole, with its links working and no em dashes`, () => {
    const md = read(file);
    const { html, toc } = G.render(md);
    assert.ok(toc.filter((h) => h.level === 2).length >= 4);
    const ids = new Set(toc.map((h) => h.id));
    for (const [, guide, anchor] of html.matchAll(/data-guide="([^"]+)"(?: data-anchor="([^"]+)")?/g)) {
      assert.ok(G.GUIDES[guide], guide);
      if (anchor) assert.ok(G.render(read('docs/' + G.GUIDES[guide])).toc.some((h) => h.id === anchor), anchor);
    }
    for (const [, anchor] of html.matchAll(/<a href="#" data-anchor="([^"]+)"/g)) assert.ok(ids.has(anchor), anchor);
    assert.ok(!md.includes('—'), 'no em dashes');
  });
}

test('the guides ship: main.js reads them by name, the README links them', () => {
  assert.deepEqual(G.GUIDES, { 'how-to': 'HOW-TO.md', faq: 'FAQ.md' });
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('docs/*.md'), 'packaged although *.md is left out');
  const readme = read('README.md');
  assert.match(readme, /\(docs\/HOW-TO\.md\)/);
  assert.match(readme, /\(docs\/FAQ\.md\)/);
});
