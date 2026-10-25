// 长期事实（src/facts.js）单测。
// 只写临时目录，不碰仓库数据：node scripts/test-facts.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_FACTS_INJECT_CHARS,
  FACTS_MAX,
  MAX_FACT_CHARS,
  appendFact,
  buildFactsBlock,
  extractFacts,
  factKey,
  factsFile,
  readFacts,
  removeFact,
  searchFacts,
} from '../src/facts.js';

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✔ ${label}`); }
  catch (e) { console.log(`  ✘ ${label}: ${e?.message ?? e}`); failed += 1; }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what ?? '值'} 不一致：希望 ${b}，实际 ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what ?? '断言失败'); }
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'facts-test-')); }

const texts = (list) => list.map((f) => f.text);

console.log('提炼：认得的句式');
check('名字', () => eq(texts(extractFacts('我叫小周，你呢')), ['对方叫小周']));
check('年龄', () => eq(texts(extractFacts('我今年23岁')).length, 1));
check('城市', () => eq(texts(extractFacts('我住在杭州，最近好热')), ['对方住在杭州']));
check('在哪上班', () => ok(texts(extractFacts('我在杭州上班，天天加班')).some((t) => t.includes('杭州'))));
check('职业', () => eq(texts(extractFacts('我是程序员')), ['对方是程序员']));
check('喜欢', () => ok(texts(extractFacts('我超喜欢火锅')).some((t) => t.includes('火锅'))));
check('不吃', () => eq(texts(extractFacts('我不吃辣')), ['对方不吃辣']));
check('讨厌', () => ok(texts(extractFacts('我特别讨厌烟味')).some((t) => t.includes('烟味'))));
check('过敏', () => eq(texts(extractFacts('我对海鲜过敏')), ['对方对海鲜过敏']));
check('宠物', () => eq(texts(extractFacts('我养了只猫')), ['对方养了猫']));
check('计划', () => ok(texts(extractFacts('我明天要去考试')).some((t) => t.includes('明天'))));

console.log('提炼：不认的句式（宁漏勿错）');
check('寒暄不产事实', () => eq(extractFacts('哈哈哈哈你好啊'), []));
check('问句不产事实', () => eq(extractFacts('你在干嘛呢'), []));
check('太短不产事实', () => eq(extractFacts('嗯'), []));
check('空值安全', () => eq(extractFacts(null), []));
check('一条最多 3 条，且不重复', () => {
  const got = extractFacts('我叫阿岚，我喜欢猫，我不吃辣，我养了只猫，我明天要去考试');
  ok(got.length <= 3, `超过上限：${got.length}`);
  eq(new Set(got.map((g) => g.text)).size, got.length, '有重复');
});
check('长文只取前 160 字判断', () => {
  const got = extractFacts(`${'啊'.repeat(200)}我叫小周`);
  eq(got, [], '尾部内容不该被提炼');
});
check('正文截断在上限内', () => {
  const got = extractFacts(`我喜欢${'很长'.repeat(40)}`);
  for (const g of got) ok(g.text.length <= MAX_FACT_CHARS, `未截断：${g.text.length}`);
});

console.log('写入 / 读取 / 删重');
check('路径按角色隔离，穿越字符被削平', () => {
  const root = tmpRoot();
  ok(factsFile(root, '阿橘').endsWith(path.join('state', '阿橘', 'facts.jsonl')), '路径形状');
  ok(!factsFile(root, '../../etc/passwd').includes('..'), '穿越未处理');
});
check('追加后原样读出', () => {
  const root = tmpRoot();
  const r = appendFact(root, { role: '阿橘', text: '对方不吃辣', cat: 'dislike', conv: 'group:1' });
  eq(r.ok, true, '写入成功');
  const list = readFacts(root, '阿橘');
  eq(list.length, 1);
  eq(list[0].cat, 'dislike', '类别');
  eq(list[0].conv, 'group:1', '会话');
  eq(list[0].source, 'auto', '来源');
});
check('同内容（归一化后）只留一条', () => {
  const root = tmpRoot();
  appendFact(root, { role: '阿橘', text: '对方不吃辣' });
  const dup = appendFact(root, { role: '阿橘', text: '对方不吃辣。' });
  eq(dup.skipped, 'duplicate', '应判重');
  eq(readFacts(root, '阿橘').length, 1);
});
check('空正文 / 空角色被拒', () => {
  const root = tmpRoot();
  eq(appendFact(root, { role: '', text: '对方养了猫' }).skipped, 'no-role');
  eq(appendFact(root, { role: '阿橘', text: '   ' }).skipped, 'empty');
});
check('删一条按 at + text 定位', () => {
  const root = tmpRoot();
  const a = appendFact(root, { role: '阿橘', text: '对方养了猫' }).entry;
  appendFact(root, { role: '阿橘', text: '对方喜欢火锅' });
  const res = removeFact(root, '阿橘', { at: a.at, text: '对方养了猫' });
  eq(res.ok, true, '删除成功');
  eq(texts(readFacts(root, '阿橘')), ['对方喜欢火锅']);
  eq(removeFact(root, '阿橘', { at: a.at, text: '不存在的' }).ok, false, '不存在应失败');
});
check(`超过 ${FACTS_MAX} 条只留最新`, () => {
  const root = tmpRoot();
  for (let i = 0; i < FACTS_MAX + 5; i += 1) {
    appendFact(root, { role: '阿橘', text: `第${i}条：对方喜欢东西${i}`, at: 1000 + i });
  }
  const list = readFacts(root, '阿橘');
  eq(list.length, FACTS_MAX);
  ok(list[list.length - 1].text.includes(`${FACTS_MAX + 4}`), '最新一条应保留');
});

console.log('注入块');
check('身份排在喜好前面', () => {
  const now = Date.now();
  const facts = [
    { cat: 'preference', text: '对方喜欢火锅', at: now },
    { cat: 'identity', text: '对方叫小周', at: now - 1000 },
  ];
  const { block } = buildFactsBlock({ facts, now });
  ok(block.indexOf('身份') < block.indexOf('喜好'), `顺序不对：${block}`);
});
check('related 与 facts 重复的只出现一次', () => {
  const f = { cat: 'identity', text: '对方叫小周', at: 1 };
  const { block, used } = buildFactsBlock({ facts: [f], related: [{ ...f }], now: 2 });
  eq(used, 1);
  eq(block.split('对方叫小周').length - 1, 1);
});
check('预算小时宁可少带', () => {
  const facts = Array.from({ length: 20 }, (_, i) => ({ cat: 'preference', text: `对方喜欢第${i}样东西`, at: i }));
  const small = buildFactsBlock({ facts, budgetChars: 120, now: 1 }).used;
  const big = buildFactsBlock({ facts, budgetChars: 1000, now: 1 }).used;
  ok(small < big, `预算没起作用：${small} vs ${big}`);
  ok(small >= 1, '预算再小也该带上最重要的那条');
});
check('没事实就不给空块', () => eq(buildFactsBlock({ facts: [], now: 1 }).block, ''));
check('默认预算常量合理', () => ok(DEFAULT_FACTS_INJECT_CHARS > 100 && DEFAULT_FACTS_INJECT_CHARS <= 800));

console.log('召回');
check('按关键词命中，长词权重更高', () => {
  const facts = [
    { cat: 'identity', text: '对方叫小周', at: 1 },
    { cat: 'preference', text: '对方喜欢火锅和酸菜鱼', at: 2 },
  ];
  const got = searchFacts(facts, '今晚火锅走起', { limit: 2 });
  eq(got[0].text, '对方喜欢火锅和酸菜鱼');
});
check('没有关键词返回空', () => eq(searchFacts([{ text: '对方叫小周', at: 1 }], '？？？'), []));

console.log('归一化');
check('factKey 忽略标点空白与大小写', () => {
  eq(factKey('对方 喜欢，火锅。'), factKey('对方喜欢火锅'));
  eq(factKey('ABC'), factKey('abc'));
});

if (failed) {
  console.log(`\n失败 ${failed} 项`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
