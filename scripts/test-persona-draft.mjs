#!/usr/bin/env node
// 人格内核自动草稿（persona-draft.js）单测：
//   1) 按小标题归类（身份/称呼/说话/禁区），每类最多 2 条；
//   2) 禁区行必须标成「不说：」，否则模型会当成"该这么说"；
//   3) 没有小标题时退化成开头几行，并给出 warning；
//   4) 超预算时按块截断，不把最后一条拦腰砍断；
//   5) 生成文件的 front matter 完整（role/draft/sourceHash/generated）；
//   6) 真实角色卡跑出来的东西要有内容、不超预算、不带脏东西。
//
// 运行：node scripts/test-persona-draft.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DRAFT_MAX_CHARS,
  draftCoreBody,
  draftCoreFile,
  extractCoreSections,
  renderCoreFile,
  roleCardHash,
} from '../src/persona-draft.js';

const root = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '你是一只负责怼人的小猫，脾气急但心软。',
  '你只在被夸的时候会承认自己可爱。',
  '- 你是这里的老住户了。',
  '',
  '## 二、称呼',
  '第一次见面叫「你」，熟了就直呼名字。',
  '',
  '## 三、说话方式',
  '一句话不超过十五个字。',
  '能点头就别展开。',
  '第三句应该被丢掉（超过每类 2 条）。',
  '',
  '## 四、黑名单',
  '"亲爱的"——出现即失败。',
  '"么么哒"也别用。',
].join('\n');

await test('按小标题归类，每类最多留 2 条', () => {
  const { sections } = extractCoreSections(CARD);
  assert.equal(sections.identity.length, 2, '身份类最多 2 条');
  assert.equal(sections.address.length, 1);
  assert.equal(sections.tone.length, 2, '说话类最多 2 条');
  assert.equal(sections.taboo.length, 2);
  assert.ok(sections.identity.some((s) => s.includes('负责怼人的小猫')));
});

await test('禁区行标成「不说：」，避免被读成示范', () => {
  const { body } = draftCoreBody(CARD);
  assert.ok(body.includes('【禁区】'));
  assert.ok(body.includes('不说："亲爱的"'), body);
  assert.ok(!/(^|\n)\s*-\s*"亲爱的"/.test(body), '禁区不得以普通条目出现');
});

await test('每类带小标题，且顺序固定', () => {
  const { body } = draftCoreBody(CARD);
  const order = ['【身份】', '【称呼】', '【说话】', '【禁区】'].map((h) => body.indexOf(h));
  for (let i = 0; i < order.length; i++) assert.ok(order[i] >= 0, `缺少 ${i}`);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], '小标题顺序应为 身份→称呼→说话→禁区');
});

await test('没有小标题时退化成开头几行并给出 warning', () => {
  const plain = ['这是一段没有标题的角色卡。', '', '她是夜班的图书管理员，说话很轻。', '讨厌别人打断她。'].join('\n');
  const r = draftCoreBody(plain);
  assert.ok(r.body.length > 0, '不能返回空内核');
  assert.ok(r.warnings.some((w) => w.includes('退化')), r.warnings.join('|'));
});

await test('超预算时按块截断且不超上限', () => {
  const long = [
    '## 一、你是谁',
    '甲'.repeat(150),
    '乙'.repeat(150),
    '## 二、说话方式',
    '丙'.repeat(150),
    '丁'.repeat(150),
    '## 三、黑名单',
    '戊'.repeat(150),
  ].join('\n');
  const r = draftCoreBody(long);
  assert.ok(r.body.length <= DRAFT_MAX_CHARS, `实际 ${r.body.length}`);
  assert.ok(r.warnings.some((w) => w.includes('截断')), r.warnings.join('|'));
  assert.ok(!r.body.endsWith('…'), '按块截断不该出现硬切标记');
});

await test('生成文件 front matter 完整且默认生效（draft: false）', () => {
  const text = renderCoreFile({ roleName: '测试', body: '【身份】\n- 你是一只猫。', sourceHash: 'abc123abc123' });
  assert.match(text, /^---\n/);
  assert.match(text, /^role: 测试$/m);
  assert.match(text, /^draft: false$/m);
  assert.match(text, /^generated: true$/m);
  assert.match(text, /^sourceHash: abc123abc123$/m);
  assert.ok(text.includes('【身份】'));
});

await test('sourceHash 跟随角色卡变化', () => {
  assert.notEqual(roleCardHash(CARD), roleCardHash(`${CARD}\n补充一行。`));
  assert.match(roleCardHash(CARD), /^[0-9a-f]{12}$/);
});

await test('示例角色卡：有内容、不超预算、不带 markdown 残留', () => {
  const card = fs.readFileSync(new URL('../examples/role-card.example.md', import.meta.url), 'utf8');
  const r = draftCoreFile(card, { roleName: '阿橘' });
  assert.ok(r.body.length > 80, `抽出来太少了：${r.body.length}`);
  assert.ok(r.body.length <= DRAFT_MAX_CHARS);
  assert.ok(r.body.includes('【身份】'));
  assert.ok(!r.body.includes('**'), '不得残留粗体标记');
  assert.ok(!r.body.includes('```'), '不得残留代码围栏');
});

if (failures) {
  console.error(`\n失败 ${failures} 项`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
