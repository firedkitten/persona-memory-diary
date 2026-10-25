#!/usr/bin/env node
// 查看某角色的日记，并预览「这一轮会注入什么」。
//
// 用法：
//   node scripts/preview-diary.mjs --root ./memory 阿橘
//   node scripts/preview-diary.mjs --root ./memory 阿橘 火锅
//
// 参数：
//   --root <dir>   数据根目录（默认当前目录，或环境变量 MEMORY_ROOT）
//   第一个非选项参数是角色名，第二个是可选的关键词
//
// 只读：不改任何文件。
import fs from 'node:fs';
import path from 'node:path';
import { buildDiaryBlock, diaryFile, formatRelative, readDiary, searchDiary } from '../src/diary.js';

function argValue(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = path.resolve(argValue('--root', process.env.MEMORY_ROOT || process.cwd()));
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !String(all[i - 1]).startsWith('--'));
const role = positional[0] || process.env.ROLE || '';
const query = positional[1] || '';

if (!role) {
  console.error('没有角色：传一个名字，如 `node scripts/preview-diary.mjs --root ./memory 阿橘`');
  process.exit(1);
}

const file = diaryFile(ROOT, role);
if (!fs.existsSync(file)) {
  console.log(`「${role}」还没有日记：\n   ${file}\n   等宿主写入第一条就会自动出现。`);
  process.exit(0);
}

const all = readDiary(ROOT, role);
const now = Date.now();
console.log(`角色：${role}　共 ${all.length} 条　文件：${file}`);
for (const e of all.slice(-12)) {
  const extra = e.extra?.target ? `（${e.extra.target}）` : '';
  console.log(`  ${formatRelative(e.at, now).padEnd(6)} [${e.kind}] ${e.text}${extra}`);
}

const recent = all.slice(-6);
const related = query ? searchDiary(all, query, { limit: 3 }) : [];
const { block, used } = buildDiaryBlock({ recent, related, budgetChars: 400 });
console.log(`\n本次会注入 ${used} 条${query ? `（含关键词「${query}」召回）` : ''}：`);
console.log(block || '（空）');
