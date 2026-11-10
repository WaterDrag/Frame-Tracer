/* icons.js – SVG ikony zařízení (vlastní kresba, styl síťových diagramů) */
(function (root) {
  'use strict';
  const S = {
    router: `<g><ellipse cx="32" cy="38" rx="26" ry="9" fill="#1e5aa8"/><rect x="6" y="22" width="52" height="16" fill="#2b6fc2"/><ellipse cx="32" cy="22" rx="26" ry="9" fill="#4a90e2"/>
      <g stroke="#fff" stroke-width="2.4" fill="#fff" stroke-linecap="round"><path d="M22 19l-8 3M14 22l3.5-3.6M14 22l4.5 1.4" fill="none"/><path d="M42 25l8-3M50 22l-3.5 3.6M50 22l-4.5-1.4" fill="none"/>
      <path d="M30 15.5l3-2.5M33 13l-.4 3.8M33 13l-3.6.6" fill="none"/><path d="M34 28.5l-3 2.5M31 31l.4-3.8M31 31l3.6-.6" fill="none"/></g></g>`,
    switch: `<g><path d="M8 24l10-10h40l-10 10z" fill="#4a90e2"/><path d="M48 24l10-10v20l-10 10z" fill="#1e5aa8"/><rect x="8" y="24" width="40" height="20" fill="#2b6fc2"/>
      <g stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14 30h14l-3-3M42 38H28l3 3"/><path d="M42 30h-8l3-3M14 38h8l-3 3" opacity=".75"/></g></g>`,
    l3switch: `<g><path d="M8 24l10-10h40l-10 10z" fill="#5aa0ea"/><path d="M48 24l10-10v20l-10 10z" fill="#1e5aa8"/><rect x="8" y="24" width="40" height="20" fill="#2b6fc2"/>
      <g stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14 30h14l-3-3M42 38H28l3 3"/></g><circle cx="40" cy="30" r="3.2" fill="#fbbf24"/><text x="27" y="22" font-size="7" font-weight="700" fill="#fff" font-family="Segoe UI,sans-serif">L3</text></g>`,
    pc: `<g><rect x="12" y="10" width="40" height="28" rx="2.5" fill="#cfd8e3" stroke="#5b6b80" stroke-width="2"/><rect x="16" y="14" width="32" height="20" fill="#1f6fc5"/><path d="M18 30l8-9 6 6 4-4 10 7z" fill="#8cc4ff" opacity=".7"/>
      <path d="M27 38h10l2 6H25z" fill="#9aa8b8"/><rect x="18" y="44" width="28" height="4" rx="1.5" fill="#7d8b9c"/></g>`,
    laptop: `<g><rect x="15" y="12" width="34" height="23" rx="2" fill="#cfd8e3" stroke="#5b6b80" stroke-width="2"/><rect x="18.5" y="15.5" width="27" height="16" fill="#1f6fc5"/><path d="M8 37h48l-4 7H12z" fill="#9aa8b8" stroke="#5b6b80" stroke-width="1.5"/><rect x="27" y="39" width="10" height="2" fill="#5b6b80"/></g>`,
    server: `<g><rect x="20" y="6" width="24" height="42" rx="2.5" fill="#cfd8e3" stroke="#5b6b80" stroke-width="2"/><g fill="#5b6b80"><rect x="24" y="11" width="16" height="3" rx="1"/><rect x="24" y="17" width="16" height="3" rx="1"/><rect x="24" y="23" width="16" height="3" rx="1"/></g><circle cx="27" cy="40" r="2" fill="#22c55e"/><circle cx="33" cy="40" r="2" fill="#3b82f6"/></g>`,
    printer: `<g><rect x="20" y="8" width="24" height="12" fill="#f8fafc" stroke="#5b6b80" stroke-width="2"/><rect x="10" y="18" width="44" height="20" rx="3" fill="#cfd8e3" stroke="#5b6b80" stroke-width="2"/><rect x="18" y="32" width="28" height="12" fill="#f8fafc" stroke="#5b6b80" stroke-width="2"/><circle cx="47" cy="24" r="2" fill="#22c55e"/></g>`,
    hub: `<g><rect x="8" y="20" width="48" height="16" rx="3" fill="#2b6fc2"/><g fill="#fff"><circle cx="16" cy="28" r="2.2"/><circle cx="24" cy="28" r="2.2"/><circle cx="32" cy="28" r="2.2"/><circle cx="40" cy="28" r="2.2"/><circle cx="48" cy="28" r="2.2"/></g></g>`,
    cloud: `<g><path d="M18 42h30a10 10 0 0 0 1-20 13 13 0 0 0-25-3 9 9 0 0 0-6 23z" fill="#dbe7f5" stroke="#5b8cc4" stroke-width="2.2"/></g>`,
    ap: `<g><rect x="14" y="30" width="36" height="12" rx="4" fill="#2b6fc2"/><g stroke="#4a90e2" stroke-width="2.4" fill="none" stroke-linecap="round"><path d="M24 22a11 11 0 0 1 16 0"/><path d="M19 17a18 18 0 0 1 26 0"/></g><circle cx="32" cy="27" r="2.5" fill="#4a90e2"/></g>`,
    other: `<g><rect x="12" y="12" width="40" height="32" rx="6" fill="#64748b"/><text x="32" y="34" font-size="16" font-weight="700" text-anchor="middle" fill="#fff" font-family="Segoe UI,sans-serif">?</text></g>`
  };
  function defs() {
    let s = '<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="var(--grid)" stroke-width="1"/></pattern>';
    for (const [k, v] of Object.entries(S)) s += `<symbol id="ico-${k}" viewBox="0 0 64 52">${v}</symbol>`;
    s += '<symbol id="ico-env" viewBox="0 0 20 14"><rect x="1" y="1" width="18" height="12" rx="2" fill="currentColor" stroke="#0b1220" stroke-width="1"/><path d="M2 2l8 6 8-6" fill="none" stroke="#0b1220" stroke-width="1.2"/></symbol>';
    return s;
  }
  const icon = kind => `<svg viewBox="0 0 64 52"><use href="#ico-${S[kind] ? kind : 'other'}"/></svg>`;
  root.Icons = { defs, icon, has: k => !!S[k] };
})(this);
