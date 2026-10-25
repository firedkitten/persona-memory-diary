// 事件日记（src/diary.js）单测。
// 会写临时目录，不碰仓库数据：node scripts/test-diary.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_INJECT_CHARS,
  MAX_TEXT_CHARS,
  appendDiary,
  buildDiaryBlock,
  diaryFile,
  formatRelative,
  queryTerms,
  readDiary,
  sanitizeRoleName,
  searchDiary,
} from '../src/diary.js';

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (e) { console.log(`  ❌ ${label}: ${e?.message ?? e}`); failed += 1; }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what ?? '值'} 不一致：期望 ${b}，实际 ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what ?? '断言失败'); }

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diary-test-'));
}

console.log('路径与消毒');
check('角色名过滤路径字符，文件落在 state/<角色>/', () => {
  eq(sanitizeRoleName('../../etc/passwd'), 'etcpasswd', '穿越被削平');
  eq(sanitizeRoleName('阿橘'), '阿橘', '中文保留');
  const root = tmpRoot();
  ok(diaryFile(root, '阿橘').endsWith(path.join('state', '阿橘', 'diary.jsonl')), '路径形态');
});

console.log('写入 / 读取');
check('追加后能原样读出，字段齐全', () => {
  const root = tmpRoot();
  const r = appendDiary(root, { role: '阿橘', conv: 'group:1', kind: 'topic', text: '在聊火锅', imp: 3, at: Date.now() - 3 * 60 * 60 * 1000 });
  eq(r.ok, true, '写入成功');
  const list = readDiary(root, '阿橘');
  eq(list.length, 1, '一条');
  eq(list[0].text, '在聊火锅', '正文');
  eq(list[0].kind, 'topic', '类别');
  eq(list[0].conv, 'group:1', '会话');
});
check('多行正文压成一行；超长截到上限', () => {
  const root = tmpRoot();
  appendDiary(root, { role: '阿橘', text: '第一行\n\n第二行   多空格', at: Date.now() });
  appendDiary(root, { role: '阿橘', text: '长'.repeat(500), conv: 'other', at: Date.now() });
  const list = readDiary(root, '阿橘');
  eq(list[0].text, '第一行 第二行 多空格', '空白被压平');
  eq(list[1].text.length, MAX_TEXT_CHARS, '超长被截断');
});
check('两个人格的日记互不影响', () => {
  const root = tmpRoot();
  appendDiary(root, { role: '阿橘', text: '橘猫的事', at: Date.now() });
  appendDiary(root, { role: '阿青', text: '助手的事', at: Date.now() });
  eq(readDiary(root, '阿橘').map((e) => e.text), ['橘猫的事'], '阿橘');
  eq(readDiary(root, '阿青').map((e) => e.text), ['助手的事'], '助手');
});

console.log('去重 / 轮转');
check('10 分钟内同会话同内容只记一次', () => {
  const root = tmpRoot();
  const now = Date.now();
  appendDiary(root, { role: '阿橘', conv: 'group:1', text: '答应明天画饼', at: now });
  const again = appendDiary(root, { role: '阿橘', conv: 'group:1', text: '答应明天画饼', at: now + 60 * 1000 });
  eq(again.skipped, 'duplicate', '第二次被判重');
  eq(readDiary(root, '阿橘').length, 1, '只留一条');
});
check('超过窗口的重复内容会再记一条（说明这是两件事）', () => {
  const root = tmpRoot();
  const now = Date.now();
  appendDiary(root, { role: '阿橘', conv: 'group:1', text: '今天吃了白饭', at: now - 30 * 60 * 1000 });
  appendDiary(root, { role: '阿橘', conv: 'group:1', text: '今天吃了白饭', at: now });
  eq(readDiary(root, '阿橘').length, 2, '两条');
});
check('不同会话同一句话不算重复', () => {
  const root = tmpRoot();
  appendDiary(root, { role: '阿橘', conv: 'group:1', text: '早', at: Date.now() });
  appendDiary(root, { role: '阿橘', conv: 'group:2', text: '早', at: Date.now() });
  eq(readDiary(root, '阿橘').length, 2, '两条');
});
check('超阈值轮转，只保留最新几行', () => {
  const root = tmpRoot();
  for (let i = 0; i < 12; i += 1) {
    appendDiary(root, { role: '阿橘', text: `第 ${i} 件事`, at: 1000 + i }, { rotateBytes: 200, keepLines: 3 });
  }
  const list = readDiary(root, '阿橘');
  ok(list.length <= 3, `轮转后 ${list.length} 行，应 ≤3`);
  eq(list[list.length - 1].text, '第 11 件事', '保留最新');
});

console.log('检索');
check('中文按二元组切词', () => {
  const terms = queryTerms('火锅');
  ok(terms.includes('火锅'), '保留二元组');
  ok(terms.includes('火') && terms.includes('锅'), '也拆单字');
});
check('关键词命中优先，同分取新', () => {
  const entries = [
    { at: 1, text: '在聊火锅' },
    { at: 2, text: '明天要下雨' },
    { at: 3, text: '火锅店关门了' },
  ];
  const hits = searchDiary(entries, '火锅', { limit: 2 });
  eq(hits.length, 2, '两条命中');
  eq(hits[0].at, 3, '同为命中时取新的');
});
check('没有任何关键词命中时返回空', () => {
  eq(searchDiary([{ at: 1, text: '火锅' }], '编程'), []);
});

console.log('注入块');
check('合并去重、按时间倒序、带相对时间与类别', () => {
  const now = Date.now();
  const recent = [{ at: now - 2 * 60 * 60 * 1000, kind: 'topic', text: '在聊火锅' }];
  const related = [{ at: now - 2 * 60 * 60 * 1000, kind: 'topic', text: '在聊火锅' }, { at: now - 3 * 24 * 60 * 60 * 1000, kind: 'thought', text: '答应周末画饼' }];
  const { block, used } = buildDiaryBlock({ recent, related, now });
  eq(used, 2, '去重后两条');
  ok(block.startsWith('【日记 · 记忆锚点】'), '标题');
  ok(block.includes('2小时前 · 话题：在聊火锅'), '相对时间与类别');
  ok(block.indexOf('2小时前') < block.indexOf('3天前'), '新的在前');
});
check('超预算的条目被跳过，整块不超预算', () => {
  const now = Date.now();
  const many = Array.from({ length: 20 }, (_, i) => ({ at: now - i * 60000, kind: 'event', text: `第${i}件${'很长的描述'.repeat(10)}` }));
  const { chars } = buildDiaryBlock({ recent: many, now, budgetChars: 200 });
  ok(chars <= 200, `实际 ${chars} 应 ≤200`);
});
check('没有条目时不出块', () => {
  eq(buildDiaryBlock({ recent: [], related: [] }).block, '');
  ok(DEFAULT_INJECT_CHARS > 0, '默认预算');
});

console.log('时间格式');
check('刚刚 / 分钟 / 小时 / 天', () => {
  const now = Date.now();
  eq(formatRelative(now - 1000, now), '刚刚');
  eq(formatRelative(now - 5 * 60000, now), '5分钟前');
  eq(formatRelative(now - 3 * 3600 * 1000, now), '3小时前');
  eq(formatRelative(now - 2 * 86400 * 1000, now), '2天前');
  eq(formatRelative(0, now), '时间未知');
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
