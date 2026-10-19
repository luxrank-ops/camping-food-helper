// 서버 코드 전체 문법 검사 (node --check).
// 예전에는 `npm run lint`/`npm run build`가 server.js만 검사해서
// api/·lib/·scripts/의 문법 오류는 CI에서나 발견됐다. 로컬에서도 같은 범위를 검사한다.
//
// 실행: npm run lint
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIRS = ['api', 'lib', 'scripts'];

function collect(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collect(full));
    else if (/\.(js|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const files = [
  path.join(ROOT, 'server.js'),
  ...TARGET_DIRS.flatMap((dir) => collect(path.join(ROOT, dir)))
].sort();

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`✖ ${path.relative(ROOT, file)}`);
    console.error((result.stderr || result.stdout || '').trim());
  }
}

if (failed) {
  console.error(`check-syntax: ${failed}/${files.length}개 파일에서 문법 오류`);
  process.exit(1);
}
console.log(`check-syntax: ${files.length}개 파일 문법 검사 통과`);
