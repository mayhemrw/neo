// Builds the standalone verifier page (verifier.html): page.html with the
// checker's files and the trusted certificates put inside it, so it's one
// file that works from a double-click, offline, with nothing beside it.
// NEO builds it for every export (main.js); scripts/build-verifier.js
// writes it to verifier/verifier.html.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// In the order they need each other
const MODULES = ['slog-hash.js', 'slog-zip.js', 'stamp-tsa.js', 'stamp-ots.js', 'slog-verify.js', 'slog-report.js', 'slog-diff.js', 'slog-playback.js', 'verifier/manuscript.js', 'verifier/check.js', 'verifier/page.js'];

// What a Scribe's Log can and can't show (NEO's own words, in main.js and app.js)
const CAN_SHOW = [
  'A Scribe\'s Log can show that it hasn\'t been altered since each outside timestamp, that the writing happened over the dates shown, which text was typed in NEO, moved within the book, pasted from outside or imported, and that it ends in exactly a given manuscript.',
  'It can\'t show that a person pressed the keys, that the ideas weren\'t a machine\'s, or anything about writing done outside NEO. It\'s a record of the writing process, not proof of authorship.'
];

// JavaScript made safe to sit inside <script>…</script>: the sequences that
// would end the element or change how HTML reads it are written with \x3C
// for the "<". They only occur in strings, templates and regular
// expressions, where \x3C means "<" too.
function scriptSafe(js) {
  return js.replace(/<(?=\/script|script|!--)/gi, '\\x3C');
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The trusted certificates (certs/): every *-root.pem is a trust anchor,
// the other .pem files are certificates that help build a chain
function shippedCerts(dir = path.join(ROOT, 'certs')) {
  const anchors = [];
  const certs = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.pem')).sort()) {
    (/-root\.pem$/.test(f) ? anchors : certs).push(fs.readFileSync(path.join(dir, f), 'utf8').trim());
  }
  return { anchors, certs };
}

// opts: { version (NEO's), anchors, certs (PEM strings; the shipped ones by
// default), extraAnchors (PEM, for tests), built (a date for the page) }
function buildVerifier(opts = {}) {
  const version = opts.version || require(path.join(ROOT, 'package.json')).version;
  const shipped = shippedCerts();
  const config = {
    version,
    anchors: [...(opts.anchors || shipped.anchors), ...(opts.extraAnchors || [])],
    certs: opts.certs || shipped.certs,
    canShow: CAN_SHOW
  };
  let html = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
  const scripts = [
    `<script>\nglobalThis.VERIFIER_CONFIG = ${scriptSafe(JSON.stringify(config))};\n</script>`,
    ...MODULES.map((m) => `<script>\n// ${m}\n${scriptSafe(fs.readFileSync(path.join(ROOT, m), 'utf8'))}\n</script>`)
  ].join('\n');
  html = html.replace('<!--CAN SHOW-->', CAN_SHOW.map((p) => `<p>${esc(p)}</p>`).join('\n  '));
  html = html.split('{{VERSION}}').join(esc(version));
  html = html.split('{{BUILT}}').join(esc(opts.built || 'built with NEO'));
  // (a function, so a "$" in the scripts is never read as a pattern)
  html = html.replace('<!--MODULES-->', () => scripts);
  return html;
}

module.exports = { buildVerifier, scriptSafe, shippedCerts, MODULES, CAN_SHOW };
