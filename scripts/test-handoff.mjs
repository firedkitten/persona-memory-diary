#!/usr/bin/env node
// 交接单（handoff.js）单测：
//   1) 事实按「身份 > 雷点 > 关系 > 计划 > 喜好」排序，宁多记关键的；
//   2) 条数上限生效，不会无限长；
//   3) Markdown 结构完整（人/迁移都能读）；
//   4) 注入块按预算裁，且带「上一次会话」标题，避免被当成本轮内容；
//   5) pending 判定：未用过且窗口匹配才注入；
//   6) 落盘/读取/标记已用 闭合；坏文件当没有，不抛。
//
// 运行：node scripts/test-handoff.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HANDOFF_HEADER,
  buildHandoff,
  handoffBlock,
  handoffPath,
  isHandoffPending,
  markHandoffUsed,
  readHandoff,
  renderHandoffMarkdown,
  writeHandoff,
} from '../src/handoff.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const facts = [
  { cat: 'preference', text: '喜欢猫' },
  { cat: 'plan', text: '下月去看海' },
  { cat: 'identity', text: '名字：小周' },
  { cat: 'dislike', text: '不吃辣' },
  { cat: 'relation', text: '养了只橘猫叫年糕' },
];
const diary = Array.from({ length: 12 }, (_, i) => ({ at: 1000 + i, kind: 'event', text: `第 ${i} 件事` }));
const memory = { topics: ['在给猫起名', '周末去爬山'], thoughts: ['想问她要照片'] };

await test('事实按类别权重排序，最多 8 条', () => {
  const h = buildHandoff({ role: '阿橘', scope: 'private:1', facts, diary, memory, stats: { turns: 42 } });
  assert.equal(h.facts[0].text, '名字：小周', '身份类排最前');
  assert.equal(h.facts[1].cat, 'dislike');
  assert.ok(h.facts.length <= 8);
  assert.equal(h.stats.turns, 42);
});

await test('日记取最近 8 条，按时间倒序', () => {
  const h = buildHandoff({ role: '阿橘', diary });
  assert.equal(h.recent.length, 8);
  assert.equal(h.recent[0].text, '第 11 件事');
});

await test('Markdown 结构完整', () => {
  const h = buildHandoff({ role: '阿橘', scope: 'group:9', facts, diary, memory, stats: { turns: 7 } });
  const md = renderHandoffMarkdown(h, { now: Date.UTC(2026, 9, 25, 4, 0) });
  for (const needle of ['# 交接单 · 阿橘', '会话窗口：group:9', '对方是谁', '最近发生', '还在聊的事', '上次没说完的']) {
    assert.ok(md.includes(needle), `缺「${needle}」`);
  }
  assert.ok(md.includes('名字：小周'));
  assert.ok(md.includes('想问她要照片'));
});

await test('注入块带标题、按预算裁、不超长', () => {
  const h = buildHandoff({ role: '阿橘', scope: 'private:1', facts, diary, memory, stats: { turns: 120 } });
  const { block, chars } = handoffBlock(h, { budgetChars: 300 });
  assert.ok(block.startsWith(HANDOFF_HEADER), block.slice(0, 40));
  assert.ok(block.includes('上一次会话'), '要明确写清是上一次会话');
  assert.ok(chars <= 300, `实际 ${chars}`);
  assert.ok(block.length < 420);
});

await test('空数据也能出块，只是很短（不能拼出半个标题）', () => {
  const h = buildHandoff({ role: '阿橘' });
  const { block } = handoffBlock(h);
  assert.equal(block, '', '没内容就不该占预算');
});

await test('pending 判定：未用 + 窗口匹配', () => {
  const h = buildHandoff({ role: '阿橘', scope: 'private:1', facts: [facts[0]] });
  assert.equal(isHandoffPending(h, 'private:1'), true);
  assert.equal(isHandoffPending(h, 'group:2'), false, '别的窗口的交接单不该串过来');
  h.usedAt = Date.now();
  assert.equal(isHandoffPending(h, 'private:1'), false, '用过就不再注入');
  const noScope = buildHandoff({ role: '阿橘', facts: [facts[0]] });
  assert.equal(isHandoffPending(noScope, 'private:1'), true, '没标窗口的视为通用');
});

await test('落盘 / 读取 / 标记已用 闭合，且有归档 Markdown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  const h = buildHandoff({ role: '阿橘', scope: 'private:1', facts, diary, memory, stats: { turns: 5 } });
  const out = writeHandoff(dir, h);
  assert.ok(fs.existsSync(out.file));
  assert.ok(fs.existsSync(out.markdown), '要留一份人能读的 Markdown');
  assert.equal(handoffPath(dir, '阿橘'), out.file);

  const back = readHandoff(dir, '阿橘');
  assert.equal(back.role, '阿橘');
  assert.equal(back.scope, 'private:1');

  assert.equal(markHandoffUsed(dir, '阿橘'), true);
  assert.ok(readHandoff(dir, '阿橘').usedAt > 0);
  assert.equal(isHandoffPending(readHandoff(dir, '阿橘'), 'private:1'), false);
});

await test('坏文件当没有，不抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  const file = handoffPath(dir, '阿橘');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  assert.equal(readHandoff(dir, '阿橘'), null);
  assert.equal(markHandoffUsed(dir, '阿橘'), false);
});

if (failures) {
  console.error(`\n失败 ${failures} 项`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
