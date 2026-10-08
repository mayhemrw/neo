#!/usr/bin/env node
// Writes the standalone verifier page, verifier/verifier.html (or the path
// given), from verifier/page.html and the checker's files (verifier/build.js).
// NEO builds the same page into every export by itself; this is for trying
// the page in a browser, or handing it out on its own.
//
//   node scripts/build-verifier.js [out.html]

'use strict';
const fs = require('fs');
const path = require('path');
const { buildVerifier } = require('../verifier/build.js');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'verifier', 'verifier.html'));
const html = buildVerifier({ built: 'built ' + new Date().toISOString().slice(0, 10) });
fs.writeFileSync(out, html, 'utf8');
console.log(`${out} (${Math.round(html.length / 1024)} KB)`);
