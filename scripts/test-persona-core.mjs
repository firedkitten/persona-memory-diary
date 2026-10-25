// 人格内核（src/persona-core.js）单测。
// 纯函数为主，另有两项检查仓库里的模板与示例：node scripts/test-persona-core.mjs
import { readFileSync } from 'node:fs';
import {
  CORE_HEADER,
  PERSONA_CORE_MAX_CHARS,
  buildPersonaCoreBlock,
  coreBudgetFrom,
  isDraft,
  loadPersonaCore,
  parsePersonaCore,
  personaHash,
  truncateCore,
} from '../src/persona-core.js';

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

const body = '我是阿橘。\n说话：一句话 1~10 字。';
const draftText = `---\nrole: 阿橘\nversion: 4\ndraft: true\n---\n\n${body}\n`;
const liveText = `---\nrole: 阿橘\nversion: 4\n---\n\n${body}\n`;

console.log('parsePersonaCore');
check('拆出 front matter', () => {
  const { front, body: b } = parsePersonaCore(draftText);
  eq(front.role, '阿橘', 'role');
  eq(front.version, '4', 'version');
  eq(b, body, '正文');
});
check('无 front matter 时整篇当正文', () => {
  const { front, body: b } = parsePersonaCore('纯正文');
  eq(front, {}, 'front');
  eq(b, '纯正文', '正文');
});
check('BOM 与 CRLF 不影响解析', () => {
  const { front } = parsePersonaCore('\uFEFF---\r\nrole: x\r\n---\r\n\r\ny');
  eq(front.role, 'x', 'role');
});

console.log('isDraft / personaHash');
check('draft: true 才算草稿', () => {
  eq(isDraft({ draft: 'true' }), true);
  eq(isDraft({ draft: 'false' }), false);
  eq(isDraft({}), false);
});
check('hash 12 位且同文同值、异文异值', () => {
  const a = personaHash(body);
  ok(a.length === 12 && /^[0-9a-f]{12}$/.test(a), 'hash 形态');
  eq(personaHash(body), a, '同文');
  ok(personaHash(body + 'x') !== a, '异文应不同');
});

console.log('truncateCore / buildPersonaCoreBlock');
check('预算内不截断', () => {
  const r = truncateCore(body, 600);
  eq(r.text, body, '正文');
  eq(r.truncated, false, 'truncated');
});
check('超预算按句号软截断并标记', () => {
  const long = `${'一句话。'.repeat(200)}`;
  const r = truncateCore(long, 100);
  ok(r.truncated, '应标记截断');
  ok(r.text.length <= 100, `截断后 ${r.text.length} 应 ≤100`);
  ok(r.text.endsWith('。'), '应在句号处断开');
});
check('块含标题、正文与结尾空行', () => {
  const { block } = buildPersonaCoreBlock(body, 600);
  ok(block.startsWith(CORE_HEADER), '标题');
  ok(block.includes('一句话 1~10 字'), '正文在块里');
  ok(block.endsWith('\n\n'), '结尾双换行（拼接用）');
});
check('空正文不产生块', () => {
  eq(buildPersonaCoreBlock('   ').block, '');
});

console.log('loadPersonaCore');
check('draft: true 不注入但保留 hash', () => {
  const core = loadPersonaCore(draftText);
  eq(core.draft, true, 'draft');
  eq(core.block, '', '草稿不应有注入块');
  eq(core.hash, personaHash(body), 'hash');
  eq(core.role, '阿橘', 'role');
});
check('非草稿产出可注入块且不超预算', () => {
  const core = loadPersonaCore(liveText);
  eq(core.draft, false, 'draft');
  ok(core.block.startsWith(CORE_HEADER), '块标题');
  ok(core.chars <= PERSONA_CORE_MAX_CHARS, `字符数 ${core.chars} 应 ≤ 上限`);
});
check('预算可下传（模拟收紧到 50）', () => {
  const core = loadPersonaCore(liveText, { budget: 50 });
  eq(core.truncated, false, '短正文不触发截断');
  eq(core.chars, body.length, '字符数');
});

console.log('多个人格复用');
check('每个角色可用 budgetChars 自定预算', () => {
  eq(coreBudgetFrom({ budgetChars: '300' }), 300, '正常值');
  eq(coreBudgetFrom({}), PERSONA_CORE_MAX_CHARS, '缺省回落到 600');
  eq(coreBudgetFrom({ budgetChars: '9999' }), 2000, '上限夹到 2000');
  eq(coreBudgetFrom({ budgetChars: '10' }), 100, '下限夹到 100');
  eq(coreBudgetFrom({ budgetChars: 'abc' }), PERSONA_CORE_MAX_CHARS, '写坏按缺省');
});
check('文件预算生效且能被显式入参覆盖', () => {
  const long = '这是一句很长的话。'.repeat(20);
  const text = `---\nrole: 阿青\nbudgetChars: 120\n---\n\n${long}\n`;
  const fromFile = loadPersonaCore(text);
  eq(fromFile.budget, 120, '预算取文件值');
  eq(fromFile.truncated, true, '应截断');
  ok(fromFile.chars <= 120, `截断后 ${fromFile.chars} 应 ≤120`);
  const forced = loadPersonaCore(text, { budget: 400 });
  eq(forced.budget, 400, '显式入参优先');
  eq(forced.truncated, false, '400 字预算下不截断');
});
check('两个角色的内核互不串味', () => {
  const a = loadPersonaCore(`---\nrole: 阿橘\n---\n\n我是阿橘，一只看店的橘猫。`);
  const b = loadPersonaCore(`---\nrole: 阿青\n---\n\n我是阿青，说话带刺但心软。`);
  ok(a.hash !== b.hash, '两份内核 hash 应不同');
  ok(a.block.includes('阿橘') && !a.block.includes('阿青'), 'A 只含自己');
  ok(b.block.includes('阿青') && !b.block.includes('阿橘'), 'B 只含自己');
});

console.log('磁盘上的真实内核文件');
check('examples/persona-core.example.md 已启用且可注入', () => {
  const text = readFileSync(new URL('../examples/persona-core.example.md', import.meta.url), 'utf8');
  const core = loadPersonaCore(text);
  eq(core.draft, false, 'draft 应为 false');
  ok(core.block.startsWith(CORE_HEADER), '块标题');
  ok(core.role === '阿橘', `front role 应是「阿橘」，实际 ${core.role}`);
});
check('_template.md 是草稿（不会被误注入）', () => {
  const text = readFileSync(new URL('../persona-core/_template.md', import.meta.url), 'utf8');
  const core = loadPersonaCore(text);
  eq(core.draft, true, '模板必须是 draft: true');
  eq(core.block, '', '模板不产生注入块');
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
