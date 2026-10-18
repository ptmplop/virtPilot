#!/usr/bin/env node
// No long dashes (— or –) in anything a VirtPilot user reads: the UI, the messages the server sends
// it, the installer's and the upgrade's output, the README and the release notes. The owner reads them
// as machine-written copy. Code comments and developer docs (DESIGN.md, QA.md…) are not user-facing
// and keep theirs.
//
//   node scripts/check-dashes.mjs          list every hit, exit 1 if there are any
//   node scripts/check-dashes.mjs --fix    rewrite them: " — " → " - ", "1–28" → "1-28"
//   node scripts/check-dashes.mjs --dist   check the built frontend instead (after npm run build)
//
// TypeScript and JavaScript are parsed, not grepped, so only string, template and JSX text is ever read
// or rewritten (tests and .d.ts files are skipped). --fix leaves to a person a dash that stands for "no
// value" ('—' on its own), one that starts a Markdown line (where "- " would make a bullet), and one
// written another way (an escape, an HTML entity, a character code, CSS): those are listed instead.
// Text stored by older versions is cleaned as the API reads it, by
// packages/backend/src/lib/plainDashes.ts, the same rewrite as undash() below.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fix = process.argv.includes('--fix');
const DASH = /[—–]/;
const ENTITY = /&(?:mdash|ndash|#8212|#8211|#x2014|#x2013);/i;
const JS_ESCAPE = /\\u(?:201[34]|\{201[34]\})|\\x(?:e2\\x80\\x9[34])/i;
const CSS_ESCAPE = /\\0{0,2}201[34]/i;

const hits = [];
const manual = [];
const rel = (file) => path.relative(root, file);
const flat = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 150);
const report = () => {
  if (!fix) hits.forEach((h) => console.log(h));
  manual.forEach((m) => console.log(m));
};

function walk(dir, test, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, test, out);
    else if (test(name)) out.push(p);
  }
  return out;
}

// ── --dist: the built frontend has no comments, so any dash in it, in any spelling, is real ──
if (process.argv.includes('--dist')) {
  const dist = path.join(root, 'packages/frontend/dist');
  const files = walk(dist, (n) => /\.(js|css|html|webmanifest|svg|json)$/.test(n));
  if (!files.length) { console.error('no build in packages/frontend/dist: run npm run build first'); process.exit(2); }
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of [/[—–]/g, new RegExp(JS_ESCAPE.source, 'gi'), new RegExp(CSS_ESCAPE.source, 'gi'), new RegExp(ENTITY.source, 'gi')]) {
      for (const m of text.matchAll(re)) manual.push(`${rel(file)}  ${flat(text.slice(Math.max(0, m.index - 50), m.index + 30))}`);
    }
  }
  report();
  console.error(`built frontend: ${manual.length} dash(es) in ${files.length} files`);
  process.exit(manual.length ? 1 : 0);
}

const ts = require('typescript');

// The mechanical rewrite: a dash between words becomes a spaced hyphen, the way people type it, and
// an en dash in a number range becomes a plain hyphen. A dash at the start or end of the text (or of
// a line) gets no space on that side.
function undash(text) {
  return text
    .replace(/(\d)[ \t]*–[ \t]*(\d)/g, '$1-$2')
    .replace(/([ \t]*)[—–]([ \t]*)/g, (m, lead, trail, off, s) => {
      const prev = s[off - 1];
      const next = s[off + m.length];
      const before = lead !== '' || (prev !== undefined && prev !== '\n');
      const after = trail !== '' || (next !== undefined && next !== '\n');
      return `${before ? ' ' : ''}-${after ? ' ' : ''}`;
    });
}

// ── TypeScript and JavaScript: string literals, template pieces, JSX text ──
const K = ts.SyntaxKind;
// [chars before the text, chars after it] for each kind, so a rewrite never touches the delimiters.
const DELIMS = {
  [K.StringLiteral]: [1, 1],
  [K.NoSubstitutionTemplateLiteral]: [1, 1],
  [K.TemplateHead]: [1, 2],   // `…${
  [K.TemplateMiddle]: [1, 2], // }…${
  [K.TemplateTail]: [1, 1],   // }…`
  [K.JsxText]: [0, 0],
};
// A dash on its own means "no value": '—' as a whole string, or the only text in a JSX element.
function isPlaceholder(n, content) {
  if (n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral) return /^[—–]$/.test(content);
  if (n.kind === K.JsxText) {
    if (!/^\s*[—–]\s*$/.test(content)) return false;
    const siblings = n.parent?.children ?? [];
    return siblings.every((c) => c === n || (c.kind === K.JsxText && !c.text.trim()));
  }
  return false;
}
const CHAR_CODES = new Set([8212, 8211]);
const isDashCode = (a) => a && ts.isNumericLiteral(a) && CHAR_CODES.has(Number(a.text));

const sources = ['packages/frontend/src', 'packages/backend/src'].flatMap((d) =>
  // Tests are never shown to anyone, and plainDashes.test.ts feeds dashes on purpose.
  walk(path.join(root, d), (n) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(n) && !/\.(d|test)\.[cm]?[jt]sx?$/.test(n)));
for (const file of sources) {
  const src = fs.readFileSync(file, 'utf8');
  if (!DASH.test(src) && !ENTITY.test(src) && !JS_ESCAPE.test(src) && !/fromC(?:harCode|odePoint)/.test(src)) continue;
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX
    : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const at = (pos) => `${rel(file)}:${sf.getLineAndCharacterOfPosition(pos).line + 1}`;
  const edits = [];
  (function visit(n) {
    const d = DELIMS[n.kind];
    if (d) {
      const s = n.kind === K.JsxText ? n.pos : n.getStart(sf);
      const e = n.getEnd();
      const raw = src.slice(s, e);
      const content = raw.slice(d[0], raw.length - d[1]);
      if (DASH.test(raw)) {
        if (isPlaceholder(n, content)) manual.push(`${at(s + raw.search(DASH))}  [placeholder]  ${flat(src.slice(Math.max(0, s - 60), e + 20))}`);
        else {
          hits.push(`${at(s + raw.search(DASH))}  ${flat(raw)}`);
          edits.push([s, e, raw.slice(0, d[0]) + undash(content) + raw.slice(raw.length - d[1])]);
        }
      } else if (n.kind !== K.JsxText && DASH.test(n.text ?? '')) {
        manual.push(`${at(s)}  [escape]  ${flat(raw)}`);
      }
      // React renders &mdash; in JSX text and in a JSX attribute's string as a real dash.
      if ((n.kind === K.JsxText || (n.kind === K.StringLiteral && n.parent && ts.isJsxAttribute(n.parent))) && ENTITY.test(raw)) {
        manual.push(`${at(s + raw.search(ENTITY))}  [entity]  ${flat(raw)}`);
      }
    }
    if (ts.isCallExpression(n) && /^String\.fromC(?:harCode|odePoint)$/.test(n.expression.getText(sf)) && n.arguments.some(isDashCode)) {
      manual.push(`${at(n.getStart(sf))}  [char code]  ${flat(n.getText(sf))}`);
    }
    n.forEachChild(visit);
  })(sf);
  if (fix && edits.length) {
    let out = src;
    for (const [s, e, next] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + next + out.slice(e);
    fs.writeFileSync(file, out);
  }
}

// ── CSS: a dash outside a comment can only be a `content:` someone sees ──
for (const file of walk(path.join(root, 'packages/frontend/src'), (n) => n.endsWith('.css'))) {
  const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  css.split('\n').forEach((line, i) => {
    if (DASH.test(line) || CSS_ESCAPE.test(line)) manual.push(`${rel(file)}:${i + 1}  [css]  ${flat(line)}`);
  });
}

// ── Shell scripts: everything but comments; heredoc bodies are output ──
// Quote state carries across lines, so a '#' that starts a line inside a multi-line string is text.
const shFiles = ['bootstrap.sh', 'install.sh', 'update.sh', 'uninstall.sh',
  ...fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => `scripts/${f}`)];
for (const name of shFiles) {
  const file = path.join(root, name);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let heredoc = null;
  let sq = false;
  let dq = false;
  let changed = false;
  lines.forEach((line, i) => {
    if (heredoc) {
      if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.tag) heredoc = null;
      else if (DASH.test(line)) {
        hits.push(`${name}:${i + 1}  ${flat(line)}`);
        if (fix) { lines[i] = undash(line); changed = true; }
      }
      return;
    }
    let comment = -1;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '\\' && !sq) { j++; continue; }
      if (c === "'" && !dq) sq = !sq;
      else if (c === '"' && !sq) dq = !dq;
      else if (c === '#' && !sq && !dq && (j === 0 || /\s/.test(line[j - 1]))) { comment = j; break; }
    }
    const code = comment < 0 ? line : line.slice(0, comment);
    if (DASH.test(code)) {
      hits.push(`${name}:${i + 1}  ${flat(code)}`);
      if (fix) { lines[i] = undash(code) + (comment < 0 ? '' : line.slice(comment)); changed = true; }
    }
    if (JS_ESCAPE.test(code)) manual.push(`${name}:${i + 1}  [escape]  ${flat(code)}`);
    const h = code.match(/<<(-?)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (h) heredoc = { strip: h[1] === '-', tag: h[2] };
  });
  if (changed) fs.writeFileSync(file, lines.join('\n'));
}

// ── Files a user opens or copies: all of their text ──
const whole = ['README.md', 'CHANGELOG.md', 'packages/frontend/index.html', 'packages/frontend/public/site.webmanifest',
  'packages/backend/.env.example', 'package.json', 'packages/frontend/package.json', 'packages/backend/package.json',
  ...walk(path.join(root, 'packages/frontend/public'), (n) => n.endsWith('.svg')).map(rel)];
for (const name of whole) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let changed = false;
  lines.forEach((line, i) => {
    if (ENTITY.test(line)) manual.push(`${name}:${i + 1}  [entity]  ${flat(line)}`);
    if (!DASH.test(line)) return;
    if (name.endsWith('.md') && /^\s*[—–]/.test(line)) { manual.push(`${name}:${i + 1}  [line start]  ${flat(line)}`); return; }
    hits.push(`${name}:${i + 1}  ${flat(line)}`);
    if (fix) { lines[i] = undash(line); changed = true; }
  });
  if (changed) fs.writeFileSync(file, lines.join('\n'));
}

report();
console.error(`${fix ? 'rewrote' : 'found'} ${hits.length}; ${manual.length} to word by hand`);
process.exit((!fix && hits.length) || manual.length ? 1 : 0);
