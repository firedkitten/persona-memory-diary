// 交接单（P4）：上下文快到上限时，把「这个窗口里发生过什么」写成一张纸，
// 换到新会话后第一轮带上——这是压缩之外的第二条命。
//
// 与日记/事实的分工：
//   事实 = 稳定画像（名字、雷点、关系），跨会话长期有效；
//   日记 = 逐条流水，靠检索召回；
//   交接单 = **一次性的会话小结**：本窗口最近在聊什么、答应过什么、没说完什么。
//   它只在换新会话后的第一轮注入一次，用完即焚（标记 usedAt），避免变成永久噪音。
//
// 设计约束：
//   1. 内容是「取数据拼出来的」，不调模型——换会话不能依赖一次额外的 LLM 调用；
//   2. 只写 JSON + Markdown，可读、可手工改、可随目录迁移；
//   3. 注入块有硬预算，超了按条裁，绝不无限增长。
import fs from 'node:fs';
import path from 'node:path';

export const HANDOFF_FILE = 'handoff.json';
export const HANDOFF_BLOCK_MAX_CHARS = 700;
/** 注入块标题：说清「这是上一次会话留下的」，否则模型会当成当前对话的一部分。 */
export const HANDOFF_HEADER = '【交接单 · 上一次会话的收尾】';

function safeRole(role) {
  const s = String(role ?? '').trim().replace(/[\\/:*?"<>|]/g, '_');
  if (!s || s === '.' || s === '..') throw new Error('非法角色名');
  return s;
}

/** 最近一份交接单（未消费的也在里面，用 usedAt 区分）。 */
export function handoffPath(rootDir, role) {
  return path.join(rootDir, 'state', safeRole(role), HANDOFF_FILE);
}

/** 历史交接单目录：一人格一个子目录，按时间戳存 Markdown，方便人翻。 */
export function handoffArchiveDir(rootDir, role) {
  return path.join(rootDir, 'handoff', safeRole(role));
}

const CAT_WEIGHT = { identity: 0, dislike: 1, taboo: 1, relation: 2, plan: 3, preference: 4, other: 5 };

/**
 * 把各路数据整理成一张交接单。
 * @param {{role:string, scope?:string, facts?:Array, diary?:Array, memory?:object, stats?:object, now?:number}} input
 */
export function buildHandoff({ role, scope = '', facts = [], diary = [], memory = {}, stats = {}, now = Date.now() } = {}) {
  const pickFacts = [...facts]
    .sort((a, b) => (CAT_WEIGHT[a?.cat] ?? 9) - (CAT_WEIGHT[b?.cat] ?? 9))
    .slice(0, 8)
    .map((f) => ({ cat: f.cat ?? '', text: String(f.text ?? '').trim() }))
    .filter((f) => f.text);

  const recentDiary = [...diary]
    .sort((a, b) => Number(b?.at ?? 0) - Number(a?.at ?? 0))
    .slice(0, 8)
    .map((d) => ({ at: Number(d?.at ?? 0), kind: d?.kind ?? '', text: String(d?.text ?? '').trim() }))
    .filter((d) => d.text);

  const topics = (Array.isArray(memory?.topics) ? memory.topics : [])
    .slice(0, 5)
    .map((t) => String(t?.content ?? t?.text ?? (typeof t === 'string' ? t : '')).trim())
    .filter(Boolean);
  const thoughts = (Array.isArray(memory?.thoughts) ? memory.thoughts : [])
    .slice(0, 3)
    .map((t) => String(t?.content ?? t?.text ?? (typeof t === 'string' ? t : '')).trim())
    .filter(Boolean);

  return {
    version: 1,
    role: safeRole(role),
    scope: String(scope ?? ''),
    at: Number(now),
    stats: {
      turns: Number(stats?.turns ?? 0),
      startedAt: Number(stats?.startedAt ?? 0),
    },
    facts: pickFacts,
    recent: recentDiary,
    topics,
    thoughts,
    usedAt: 0,
  };
}

/** 人看的那份（也是迁移时能直接读的档案）。 */
export function renderHandoffMarkdown(data, { now = Date.now() } = {}) {
  const fmt = (ms) => {
    const d = new Date(Number(ms) || 0);
    if (!Number(ms)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const lines = [
    `# 交接单 · ${data.role}`,
    '',
    `- 生成时间：${fmt(now)}`,
    `- 会话窗口：${data.scope || '（未标注）'}`,
    `- 本会话：${data.stats?.turns || 0} 轮${data.stats?.startedAt ? `，始于 ${fmt(data.stats.startedAt)}` : ''}`,
    '',
    '## 对方是谁（长期事实）',
    ...(data.facts.length ? data.facts.map((f) => `- [${f.cat || 'other'}] ${f.text}`) : ['- （还没记下什么）']),
    '',
    '## 最近发生',
    ...(data.recent.length ? data.recent.map((d) => `- ${fmt(d.at)} · ${d.kind || 'event'}：${d.text}`) : ['- （还没有日记）']),
    '',
    '## 还在聊的事',
    ...(data.topics.length ? data.topics.map((t) => `- ${t}`) : ['- （没有进行中的话题）']),
    '',
    '## 上次没说完的',
    ...(data.thoughts.length ? data.thoughts.map((t) => `- ${t}`) : ['- （没有）']),
    '',
  ];
  return lines.join('\n');
}

/** 注入块：给模型看的压缩版，按条裁到预算内。 */
export function handoffBlock(data, { budgetChars = HANDOFF_BLOCK_MAX_CHARS } = {}) {
  const budget = Math.max(200, Number(budgetChars) || HANDOFF_BLOCK_MAX_CHARS);
  const parts = [];
  const head = data.stats?.turns ? `上次会话聊了 ${data.stats.turns} 轮。` : '';
  if (head) parts.push(head);
  if (data.topics.length) parts.push(`还在聊：${data.topics.slice(0, 3).join('；')}`);
  if (data.facts.length) parts.push(`记得：${data.facts.slice(0, 5).map((f) => f.text).join('；')}`);
  if (data.recent.length) parts.push(`最近：${data.recent.slice(0, 4).map((d) => d.text).join('；')}`);
  if (data.thoughts.length) parts.push(`上次没说完：${data.thoughts.slice(0, 2).join('；')}`);

  let body = '';
  for (const p of parts) {
    const next = body ? `${body}\n${p}` : p;
    if (next.length > budget - 60) break;
    body = next;
  }
  if (!body) return { block: '', chars: 0 };
  const note = '（这是上一次会话留下的线索；别问她“我们聊到哪了”，直接接上。）';
  const block = `${HANDOFF_HEADER}\n${body}\n${note}\n\n`;
  return { block, chars: body.length };
}

/** 写盘：latest + 归档 Markdown 各一份。 */
export function writeHandoff(rootDir, data, { now = Date.now() } = {}) {
  const file = handoffPath(rootDir, data.role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  const dir = handoffArchiveDir(rootDir, data.role);
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const md = path.join(dir, `${stamp}.md`);
  fs.writeFileSync(md, renderHandoffMarkdown(data, { now }), 'utf8');
  return { file, markdown: md };
}

/** 读最近一份；文件坏了就当没有（不能因为交接单坏了就打不开会话）。 */
export function readHandoff(rootDir, role) {
  try {
    const file = handoffPath(rootDir, role);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

/** 标记已注入：同一张交接单不会每轮都出现。 */
export function markHandoffUsed(rootDir, role, { now = Date.now() } = {}) {
  const data = readHandoff(rootDir, role);
  if (!data) return false;
  data.usedAt = Number(now);
  fs.writeFileSync(handoffPath(rootDir, role), JSON.stringify(data, null, 2), 'utf8');
  return true;
}

/** 是否该注入：存在、未用过、会话窗口对得上（或该交接单没记窗口）。 */
export function isHandoffPending(data, scope = '') {
  if (!data) return false;
  if (Number(data.usedAt) > 0) return false;
  if (!data.scope || !scope) return true;
  return String(data.scope) === String(scope);
}
