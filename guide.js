// NEO's guides (Help → How-To Guide… and Help → FAQ…): docs/HOW-TO.md and
// docs/FAQ.md, read by main.js (help:guide) and shown in the window. This
// turns the little Markdown the guides use into markup: headings, para-
// graphs, numbered and bulleted lists (one level of bullets inside a
// numbered step), **bold**, *italic*, `code` and links. Every bit of text
// is escaped first, so a guide can never put markup of its own on the page.
// A link to the other guide, or to a heading, becomes a data-guide /
// data-anchor mark the window follows itself; any other link is plain text
// (the window never navigates). Also `menuPaths`, the menu names a guide
// mentions ("File → Scribe's Log → Verification Report…"), which the tests
// check against NEO's real menus. Plain JavaScript that also runs in Node.

(function (root) {
  'use strict';

  const GUIDES = { 'how-to': 'HOW-TO.md', faq: 'FAQ.md' };
  const MENUS = ['File', 'Edit', 'Format', 'View', 'Window', 'Help'];

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // a heading's id: its words, lower case, joined by hyphens
  function slug(text) {
    return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[*`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  }

  // which guide a link names, if it's one of them
  function guideOf(href) {
    const file = String(href).split('#')[0].split('/').pop();
    return Object.keys(GUIDES).find((k) => GUIDES[k] === file) || null;
  }

  // **bold**, *italic*, `code`, [text](href), on text that's escaped here
  function inline(src) {
    let out = '';
    let i = 0;
    const s = String(src);
    while (i < s.length) {
      if (s[i] === '`') {
        const end = s.indexOf('`', i + 1);
        if (end > i) { out += '<code>' + esc(s.slice(i + 1, end)) + '</code>'; i = end + 1; continue; }
      }
      if (s.startsWith('**', i)) {
        const end = s.indexOf('**', i + 2);
        if (end > i + 2) { out += '<strong>' + inline(s.slice(i + 2, end)) + '</strong>'; i = end + 2; continue; }
      }
      if (s[i] === '*' && s[i + 1] !== ' ') {
        const end = s.indexOf('*', i + 1);
        if (end > i + 1 && s[end - 1] !== ' ') { out += '<em>' + inline(s.slice(i + 1, end)) + '</em>'; i = end + 1; continue; }
      }
      if (s[i] === '[') {
        const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
        if (m) {
          const [whole, text, href] = m;
          const guide = guideOf(href);
          const anchor = href.includes('#') ? href.split('#').pop() : '';
          if (guide) out += `<a href="#" data-guide="${esc(guide)}"${anchor ? ` data-anchor="${esc(anchor)}"` : ''}>${inline(text)}</a>`;
          else if (href.startsWith('#')) out += `<a href="#" data-anchor="${esc(anchor)}">${inline(text)}</a>`;
          else out += inline(text);
          i += whole.length;
          continue;
        }
      }
      out += esc(s[i]);
      i++;
    }
    return out;
  }

  // the guide as markup, and its contents: [{ level, text, id }]
  function render(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    const toc = [];
    const used = new Set();
    let para = [];
    let list = null; // { tag, items: [{ text, sub: [] }] }
    const flushPara = () => {
      if (para.length) html.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    };
    const flushList = () => {
      if (!list) return;
      html.push(`<${list.tag}>` + list.items.map((it) => '<li>' + inline(it.text.join(' '))
        + (it.sub.length ? '<ul>' + it.sub.map((x) => '<li>' + inline(x.join(' ')) + '</li>').join('') + '</ul>' : '')
        + '</li>').join('') + `</${list.tag}>`);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flushPara(); continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        flushPara(); flushList();
        const level = h[1].length;
        let id = slug(h[2]);
        for (let n = 2; used.has(id); n++) id = slug(h[2]) + '-' + n;
        used.add(id);
        toc.push({ level, text: h[2].replace(/[*`]/g, ''), id });
        html.push(`<h${level} id="${esc(id)}">${inline(h[2])}</h${level}>`);
        continue;
      }
      const ol = /^(\d+)\.\s+(.*)$/.exec(line);
      const ul = /^[-*]\s+(.*)$/.exec(line);
      const sub = /^\s{2,}[-*]\s+(.*)$/.exec(line);
      if (sub && list && list.items.length) {
        list.items[list.items.length - 1].sub.push([sub[1]]);
        continue;
      }
      if (ol || ul) {
        flushPara();
        const tag = ol ? 'ol' : 'ul';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push({ text: [ol ? ol[2] : ul[1]], sub: [] });
        continue;
      }
      if (list && /^\s+\S/.test(line)) {
        // a step's text carried on to the next line
        const it = list.items[list.items.length - 1];
        if (it.sub.length) it.sub[it.sub.length - 1].push(line.trim()); else it.text.push(line.trim());
        continue;
      }
      flushList();
      para.push(line.trim());
    }
    flushPara();
    flushList();
    return { html: html.join('\n'), toc };
  }

  // every menu path a guide names in bold: "**File → Export → Manuscript
  // Format…**" gives ['File', 'Export', 'Manuscript Format…']
  function menuPaths(md) {
    const out = [];
    const re = /\*\*([^*]+?)\*\*/g;
    let m;
    while ((m = re.exec(String(md || '')))) {
      const parts = m[1].split('→').map((x) => x.trim());
      if (parts.length > 1 && MENUS.includes(parts[0])) out.push(parts);
    }
    return out;
  }

  const api = { GUIDES, render, inline, slug, menuPaths };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NeoGuide = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
