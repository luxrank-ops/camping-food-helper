#!/usr/bin/env node
// 브라우저로 내려가는 클라이언트 코드에 서버 전용 참조가 남아 있는지 검사한다.
//
// 왜 필요한가: 브라우저에는 `process`가 없다. 클라이언트 코드에서 process.env를 읽으면
// ReferenceError가 나서 앱 전체가 멈춘다. 서버(server.js, api/, lib/)는 검사 대상이 아니다.
//
// 검사 범위
//  - 루트의 *.html 안의 인라인 <script> 본문 (src 속성이 있는 외부 스크립트는 제외)
//  - 루트의 *.html 안의 on*="..." 이벤트 속성
//  - data/*.js (브라우저로 그대로 전달되는 데이터 스크립트)
// 서버 파일(server.js, api/, lib/)은 검사하지 않는다.
//
// 주석(// , /* */ , <!-- -->) 안의 문자열은 무시한다. 문자열 리터럴 안의 "https://" 같은
// 표현에 속아 뒤의 코드를 놓치지 않도록 간단한 토크나이저로 주석만 지운다.
//
// 실행: node scripts/check-client-env.mjs   (위반이 있으면 종료 코드 1)

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 브라우저에서 실행되면 깨지는 서버 전용 참조 목록
const FORBIDDEN = [
  { pattern: /\bprocess\.env\b/g, reason: 'process.env는 브라우저에 없다 (ReferenceError로 앱이 멈춘다)' },
  { pattern: /\brequire\s*\(/g, reason: 'require()는 브라우저에서 동작하지 않는다' },
  { pattern: /\bmodule\.exports\b/g, reason: 'module.exports는 브라우저에서 동작하지 않는다' },
  { pattern: /\b__dirname\b/g, reason: '__dirname은 브라우저에 없다' },
];

// 이 키워드 뒤의 "/"는 나눗셈이 아니라 정규식 리터럴의 시작이다
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
// 이 문자 뒤의 "/"도 정규식 리터럴의 시작이다 (나눗셈이 될 수 없는 위치)
const REGEX_AFTER_CHAR = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * 코드에서 주석만 공백으로 바꾼다. 길이와 줄바꿈 위치는 그대로 유지한다.
 * 문자열 리터럴과 정규식 리터럴 안의 따옴표는 문자열 경계로 세지 않는다.
 * (정규식 판별은 직전 의미 토큰 기준의 휴리스틱이다.)
 */
export function blankComments(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let quote = null; // 현재 열린 문자열 리터럴의 따옴표 (', ", `)
  let lastSig = '';  // 직전 의미 있는 문자 (공백·주석 제외)

  // pos 앞의 공백을 건너뛰고, 그 앞에 붙은 식별자(단어)를 돌려준다
  const precedingWord = (pos) => {
    let e = pos;
    while (e > 0 && /\s/.test(src[e - 1])) e -= 1;
    let j = e;
    while (j > 0 && /[A-Za-z_$]/.test(src[j - 1])) j -= 1;
    return src.slice(j, e);
  };

  while (i < n) {
    const c = src[i];

    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { quote = null; lastSig = c; }
      i += 1;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }

    if (c === '/') {
      const isRegex = lastSig === ''
        || REGEX_AFTER_CHAR.has(lastSig)
        || REGEX_AFTER_KEYWORD.has(precedingWord(i).trim());
      if (isRegex) {
        // 정규식 리터럴: [ ... ] 안의 "/"와 따옴표는 무시하고, 줄 끝까지 가면 정규식이 아니었던 것으로 본다
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n && src[j] !== '\n') {
          const d = src[j];
          if (d === '\\') { j += 2; continue; }
          if (inClass) { if (d === ']') inClass = false; }
          else if (d === '[') inClass = true;
          else if (d === '/') { closed = true; break; }
          j += 1;
        }
        if (closed) {
          i = j + 1;
          while (i < n && /[A-Za-z]/.test(src[i])) i += 1; // 플래그
          lastSig = '/';
          continue;
        }
      }
    }

    if (c === "'" || c === '"' || c === '`') { quote = c; lastSig = c; i += 1; continue; }
    if (!/\s/.test(c)) lastSig = c;
    i += 1;
  }
  return out.join('');
}

/** HTML 주석(<!-- -->)을 같은 길이의 공백으로 바꾼다. */
function blankHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 인라인 스크립트 블록과 on*= 속성 값을 찾는다. offset은 원본 파일 기준 위치. */
export function extractHtmlCodeRegions(html) {
  const regions = [];
  const cleaned = blankHtmlComments(html);

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of cleaned.matchAll(scriptRe)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue; // 외부 파일은 별도 파일로 검사된다
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    if (typeMatch && !/javascript|module/i.test(typeMatch[1])) continue; // JSON/템플릿 등은 실행되지 않는다
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    regions.push({ code: m[2], offset: bodyStart, label: 'inline <script>' });
  }

  const handlerRe = /\son[a-z]+\s*=\s*("([^"]*)"|'([^']*)')/gi;
  for (const m of cleaned.matchAll(handlerRe)) {
    const value = m[2] ?? m[3] ?? '';
    const valueStart = m.index + m[0].indexOf(m[1]) + 1;
    regions.push({ code: value, offset: valueStart, label: 'event attribute' });
  }
  return regions;
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** 파일 하나를 검사해서 위반 목록을 돌려준다. */
export function scanFile(relPath, content) {
  const findings = [];
  const isHtml = relPath.toLowerCase().endsWith('.html');
  const regions = isHtml
    ? extractHtmlCodeRegions(content)
    : [{ code: content, offset: 0, label: 'script file' }];

  for (const region of regions) {
    const stripped = region.label === 'event attribute'
      ? region.code
      : blankComments(region.code);
    for (const { pattern, reason } of FORBIDDEN) {
      pattern.lastIndex = 0;
      for (const m of stripped.matchAll(pattern)) {
        const offset = region.offset + m.index;
        findings.push({
          file: relPath,
          line: lineOf(content, offset),
          token: m[0],
          reason,
        });
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function listTargets() {
  const rootEntries = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isFile());
  const htmlFiles = rootEntries.filter((e) => e.name.endsWith('.html')).map((e) => e.name);
  const dataJs = readdirSync(path.join(ROOT, 'data'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.posix.join('data', e.name));
  return [...htmlFiles, ...dataJs].sort();
}

function main() {
  const targets = listTargets();
  const findings = [];
  for (const rel of targets) {
    const content = readFileSync(path.join(ROOT, rel), 'utf8');
    findings.push(...scanFile(rel, content));
  }

  const inCI = process.env.GITHUB_ACTIONS === 'true';
  for (const f of findings) {
    const msg = `${f.token} — ${f.reason}`;
    if (inCI) console.log(`::error file=${f.file},line=${f.line}::${msg}`);
    console.error(`${f.file}:${f.line}  ${msg}`);
  }

  if (findings.length > 0) {
    console.error(`\n✖ 클라이언트 코드에 서버 전용 참조 ${findings.length}건 (검사 파일 ${targets.length}개)`);
    process.exit(1);
  }
  console.log(`✔ 클라이언트 정적 스캔 통과 (검사 파일 ${targets.length}개: ${targets.join(', ')})`);
}

// 직접 실행된 경우에만 검사를 돌린다 (다른 스크립트에서 import해서 테스트할 수 있게)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
