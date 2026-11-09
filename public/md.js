// Tiny, dependency-free Markdown renderer (enough for Claude's chat output). Always escapes raw HTML.
(function () {
  'use strict';
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
  const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
  const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
  const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
  const HEAD_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const QUOTE_RE = /^\s{0,3}>/;

  const indentOf = l => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const isTableSep = l => l.includes('|') && l.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l);
  const looksImagePath = s => IMG_EXT.test(s) && !/\s/.test(s) && !/^https?:/i.test(s) && s.length < 400;
  // inside `code` the backticks delimit the path, so spaces are fine as long as it looks like a path
  const looksImagePathInCode = s => looksImagePath(s) ||
    (IMG_EXT.test(s) && s.length < 400 && !/\n/.test(s) && /^(?:[A-Za-z]:[\\/]|\\\\|\.{0,2}[\\/]|\/[a-z]\/)/i.test(s));

  function startsBlock(lines, i) {
    const l = lines[i];
    return FENCE_RE.test(l) || HEAD_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) ||
      (LIST_RE.test(l) && l.trim().length > 1) || (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]));
  }

  function splitRow(l) {
    l = l.trim();
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
    const cells = []; let cur = '', inCode = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '\\' && l[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '`') inCode = !inCode;
      if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  function codeBlock(code, lang) {
    return `<div class="code"><div class="codehead"><span>${esc(lang || '')}</span><button class="copy" type="button">複製</button></div><pre><code>${esc(code)}</code></pre></div>`;
  }

  function list(lines, start) {
    const m0 = lines[start].match(LIST_RE);
    const base = indentOf(m0[1]);
    const ordered = /\d/.test(m0[2]);
    const items = []; let i = start, cur = null;
    while (i < lines.length) {
      const l = lines[i]; const m = l.match(LIST_RE);
      if (m && indentOf(m[1]) < base + 2) {
        if (/\d/.test(m[2]) !== ordered) break;
        cur = { lines: [l.slice(m[0].length)], off: m[0].length, loose: false };
        items.push(cur); i++; continue;
      }
      if (!l.trim()) {
        let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length) break;
        const nm = lines[j].match(LIST_RE);
        if (indentOf(lines[j]) > base && !(nm && indentOf(nm[1]) < base + 2)) { cur.lines.push(''); i++; continue; }
        if (nm && indentOf(nm[1]) < base + 2 && /\d/.test(nm[2]) === ordered) { cur.loose = true; i = j; continue; }
        break;
      }
      if (indentOf(l) > base) {
        let k = 0; while (k < cur.off && k < l.length && l[k] === ' ') k++;
        cur.lines.push(l.slice(k)); i++; continue;
      }
      if (!startsBlock(lines, i)) { cur.lines.push(l.trim()); i++; continue; }
      break;
    }
    const n = ordered ? parseInt(m0[2], 10) : 1;
    let h = ordered ? `<ol${n !== 1 ? ` start="${n}"` : ''}>` : '<ul>';
    for (const it of items) {
      let t = it.lines, task = '';
      const tm = t[0].match(/^\[([ xX])\]\s+/);
      if (tm) { task = `<input type="checkbox" disabled${tm[1] !== ' ' ? ' checked' : ''}> `; t = [t[0].slice(tm[0].length), ...t.slice(1)]; }
      let inner = blocks(t);
      if (!it.loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
      h += `<li>${task}${inner}</li>`;
    }
    return [h + (ordered ? '</ol>' : '</ul>'), i];
  }

  function blocks(lines) {
    let out = '', i = 0, m;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      if ((m = l.match(FENCE_RE))) {
        const ind = m[1].length, ch = m[2][0], len = m[2].length, lang = m[3];
        const close = new RegExp('^\\s*' + (ch === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
        const buf = []; i++;
        while (i < lines.length && !close.test(lines[i])) {
          let s = lines[i], k = 0; while (k < ind && s[k] === ' ') k++;
          buf.push(s.slice(k)); i++;
        }
        i++;
        out += codeBlock(buf.join('\n'), lang);
        continue;
      }
      if ((m = l.match(HEAD_RE))) { const n = m[1].length; out += `<h${n}>${inline(m[2])}</h${n}>`; i++; continue; }
      if (HR_RE.test(l)) { out += '<hr>'; i++; continue; }
      if (QUOTE_RE.test(l)) {
        const buf = [];
        while (i < lines.length && lines[i].trim() && QUOTE_RE.test(lines[i])) { buf.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++; }
        out += '<blockquote>' + blocks(buf) + '</blockquote>';
        continue;
      }
      if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(l); i += 2;
        let h = '<div class="tablewrap"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          h += '<tr>' + splitRow(lines[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++;
        }
        out += h + '</tbody></table></div>';
        continue;
      }
      if (LIST_RE.test(l) && l.trim().length > 1) { const [h, ni] = list(lines, i); out += h; i = ni; continue; }
      const buf = [l]; i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) { buf.push(lines[i]); i++; }
      out += '<p>' + buf.map(x => inline(x.trim())).join('<br>') + '</p>';
    }
    return out;
  }

  function imgLink(p, label, code) {
    const inner = code ? `<code>${esc(label)}</code>` : esc(label);
    return `<a class="imglink" data-path="${esc(p)}" title="在右側檢視圖片">${inner}</a>`;
  }

  function fmt(t) {
    const ph = [];
    const hold = h => { ph.push(h); return '\u0000' + (ph.length - 1) + '\u0000'; };
    t = t.replace(/!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (all, txt, url) => {
      if (/^https?:\/\//i.test(url)) return hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${emph(esc(txt || url))}</a>`);
      let p = url; try { p = decodeURI(url); } catch {}
      if (looksImagePath(p.replace(/^file:\/\/\/?/i, ''))) return hold(imgLink(p, txt || p));
      return hold(`<span class="flink" title="${esc(p)}">${emph(esc(txt || p))}</span>`);
    });
    t = t.replace(/https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]）。，]/g, u => hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`));
    t = t.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s<>"'`|*?]*?\.(?:png|jpe?g|gif|webp|bmp|svg)(?![\w])/gi, p => hold(imgLink(p, p)));
    return emph(esc(t)).replace(/\u0000(\d+)\u0000/g, (a, n) => ph[+n]);
  }
  function emph(t) {
    return t.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*\w])\*(?=[^*\s])([^*]*?[^*\s])\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  }

  function inline(s) {
    let out = '', last = 0, m;
    const re = /(`+)([\s\S]*?[^`])\1(?!`)/g;
    while ((m = re.exec(s))) {
      out += fmt(s.slice(last, m.index));
      const code = m[2].replace(/^ ([\s\S]*) $/, '$1');
      const p = code.trim();
      out += looksImagePathInCode(p) ? imgLink(p, code, true) : `<code>${esc(code)}</code>`;
      last = re.lastIndex;
    }
    return out + fmt(s.slice(last));
  }

  window.md = src => blocks(String(src || '').replace(/\r\n?/g, '\n').split('\n'));
  window.escHtml = esc;
})();
