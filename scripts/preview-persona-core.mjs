#!/usr/bin/env node
// 预览「某个角色这一轮会被注入的人格内核」——多角色排查用。
//
// 用法：
//   node scripts/preview-persona-core.mjs --root ./memory 阿橘
//   MEMORY_ROOT=./memory node scripts/preview-persona-core.mjs 阿橘
//
// 参数：
//   --root <dir>   数据根目录（默认当前目录，或环境变量 MEMORY_ROOT）
//   第一个非选项参数是角色名
//
// 只读：不改任何文件，直接按宿主同一套规则解析 persona-core/<角色>.md。
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonaCore } from '../src/persona-core.js';

function argValue(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = path.resolve(argValue('--root', process.env.MEMORY_ROOT || process.cwd()));
const CORE_DIR = path.join(ROOT, 'persona-core');

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !String(all[i - 1]).startsWith('--'));
const role = positional[0] || process.env.ROLE || '';

if (!role) {
  console.error('没有角色：传一个名字，如 `node scripts/preview-persona-core.mjs --root ./memory 阿橘`');
  process.exit(1);
}

const safe = String(role).replace(/[^\w\u4e00-\u9fff-]/g, '');
const file = path.join(CORE_DIR, `${safe}.md`);
if (!fs.existsSync(file)) {
  console.log(`「${role}」没有内核文件，本轮不会注入任何内核：\n   ${file}`);
  process.exit(2);
}

const core = loadPersonaCore(fs.readFileSync(file, 'utf8'));
console.log(`角色：${role}`);
console.log(`版本：v${core.version || '?'}　预算：${core.budget} 字　正文：${core.chars} 字　hash：${core.hash}`);
if (core.draft) {
  console.log('状态：草稿（draft: true）——不注入');
  process.exit(0);
}
if (!core.block) {
  console.log('状态：正文为空——不注入');
  process.exit(0);
}
if (core.truncated) console.log('⚠️  已超预算截断（完整角色卡请走宿主自己的角色卡读取接口）');
console.log('—— 实际注入块 ——');
console.log(core.block);
