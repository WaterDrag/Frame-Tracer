/*
 * ptxml.js – bezztrátový XML parser/serializer.
 * Zachovává původní text (entity, mezery, atributy), takže nezměněné části
 * souboru se při uložení zapíší bajt po bajtu stejně.
 */
(function (root) {
  'use strict';

  const TOKEN = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<![^>]*>|[^<]+|</g;

  function parse(str) {
    const doc = { name: '#document', children: [] };
    const stack = [doc];
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(str))) {
      const top = stack[stack.length - 1];
      if (m[2]) {
        if (m[1]) { // zavírací tag
          if (stack.length > 1) stack.pop();
          continue;
        }
        const el = { name: m[2], attrs: m[3] || '', children: [], selfClose: !!m[4], parent: top };
        top.children.push(el);
        if (!m[4]) stack.push(el);
      } else {
        top.children.push({ raw: m[0], parent: top });
      }
    }
    return doc;
  }

  function serialize(node) {
    const out = [];
    (function walk(n) {
      if (n.raw !== undefined) { out.push(n.raw); return; }
      if (n.name === '#document') { n.children.forEach(walk); return; }
      if (n.selfClose && !n.children.length) { out.push('<' + n.name + n.attrs + '/>'); return; }
      out.push('<' + n.name + n.attrs + '>');
      n.children.forEach(walk);
      out.push('</' + n.name + '>');
    })(node);
    return out.join('');
  }

  const unesc = s => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" :
    e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10)));
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const isEl = n => n && n.name && n.name !== '#document';
  const kids = (el, name) => (el ? el.children.filter(c => c.name === name) : []);
  const kid = (el, name) => (el ? el.children.find(c => c.name === name) || null : null);
  function path(el, p) {
    for (const part of p.split('/')) { el = kid(el, part); if (!el) return null; }
    return el;
  }
  function text(el) {
    if (!el) return '';
    let s = '';
    for (const c of el.children) {
      if (c.raw === undefined) continue;
      if (c.raw.startsWith('<![CDATA[')) s += c.raw.slice(9, -3);
      else if (c.raw[0] !== '<') s += c.raw;
    }
    return unesc(s);
  }
  function setText(el, value) {
    if (!el) return;
    el.children = [{ raw: esc(value), parent: el }];
    el.selfClose = false;
  }
  function attr(el, name) {
    if (!el) return null;
    const m = el.attrs.match(new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')'));
    return m ? unesc(m[2] !== undefined ? m[2] : m[3]) : null;
  }
  function make(name, value, parent) {
    const el = { name, attrs: '', children: [], selfClose: false, parent };
    if (value !== undefined) el.children.push({ raw: esc(value), parent: el });
    return el;
  }
  function clone(n, parent) {
    if (n.raw !== undefined) return { raw: n.raw, parent };
    const c = { name: n.name, attrs: n.attrs, selfClose: n.selfClose, parent, children: [] };
    c.children = n.children.map(k => clone(k, c));
    return c;
  }
  function remove(el) {
    if (!el || !el.parent) return;
    const sib = el.parent.children, i = sib.indexOf(el);
    if (i < 0) return;
    // odstraň i předcházející whitespace, ať soubor zůstane úhledný
    if (i > 0 && sib[i - 1].raw !== undefined && /^\s*$/.test(sib[i - 1].raw)) sib.splice(i - 1, 2);
    else sib.splice(i, 1);
  }
  function walk(el, fn) {
    if (!el || el.raw !== undefined) return;
    if (fn(el) === false) return;
    for (const c of el.children) walk(c, fn);
  }

  const api = { parse, serialize, kid, kids, path, text, setText, attr, make, clone, remove, walk, esc, unesc, isEl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PTXml = api;
})(typeof self !== 'undefined' ? self : this);
