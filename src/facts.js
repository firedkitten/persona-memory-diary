// 长期事实（P3）：从聊天里**保守地**提炼用户画像，存 facts.jsonl，唤醒时带一小块回来。
//
// 为什么单独一层：
//   日记（diary.jsonl）记「发生过什么」，是叙事；事实（facts.jsonl）记「对方是谁」，
//   是画像。压缩后叙事可以少一点，但"她不吃辣、养了只猫、在杭州上班"这种不能丢——
//   丢了就会问出已经问过三遍的问题。
//
// 设计取舍（宁可漏，不可错）：
//   1. 只从「别人发来的消息」提炼，不看 AI 自己的话（AI 会顺着说"我也喜欢"）；
//   2. 只认第一人称陈述，且要求明确的句式（我叫…／我养了…／我不吃…），不做语义猜测；
//   3. 一条消息最多产 2 条事实；同样的句子只留一条；
//   4. 事实永久保存，但每人格最多 FACTS_MAX 条，超了丢最旧的低权重条目。
import fs from 'node:fs';
import path from 'node:path';

import { sanitizeRoleName, formatRelative, queryTerms } from './diary.js';

/** 事实文件名（每个人格一个）。 */
export const FACTS_FILE = 'facts.jsonl';
/** 每人格最多保留多少条事实。 */
export const FACTS_MAX = 200;
/** 单条事实正文上限。 */
export const MAX_FACT_CHARS = 80;
/** 注入预算默认值（字符）：约 200 token，别挤掉人设和日记。 */
export const DEFAULT_FACTS_INJECT_CHARS = 300;

/** 类别 → 注入时的短标签。 */
const CAT_LABEL = {
  identity: '身份',
  preference: '喜好',
  dislike: '雷点',
  plan: '计划',
  relation: '关系',
};

/**
 * 提炼规则。`text` 是写进事实卡的完整句子（保留主语，读起来才像人话）。
 * 每条规则都会再过一遍 `clean()`：去空白、去句末标点、截断。
 */
const RULES = [
  // 名字：我叫小周 / 我的名字叫阿岚
  { cat: 'identity', re: /(?:我叫|我的名字叫|叫我)([^\s，。！？,.!?]{1,12})/g, text: (m) => `对方叫${m[1]}` },
  // 年龄：我今年 23 / 我 23 岁
  { cat: 'identity', re: /我[^。！？\n]{0,10}?(\d{1,2})\s*岁/g, text: (m) => `对方 ${m[1]} 岁` },
  // 城市：我住在杭州 / 我家在成都 / 我在杭州上班
  { cat: 'identity', re: /我(?:住在|家在|人在)([^\s，。！？,.!?]{2,10}?)(?:，|。|$)/g, text: (m) => `对方住在${m[1]}` },
  { cat: 'identity', re: /我[^。！？\n]{0,6}?在([\u4e00-\u9fff]{2,6}?)(?:上班|工作|上学|读书|住)/g, text: (m) => `对方在${m[1]}` },
  // 职业：我是程序员 / 我是一名设计师
  { cat: 'identity', re: /我是(?:一个|一名|个)?([^\s，。！？,.!?]{0,10}?(?:程序员|设计师|学生|老师|医生|护士|会计|律师|运营|产品经理|工程师|编辑|公务员|店主|老板))/g, text: (m) => `对方是${m[1]}` },
  // 喜好：我喜欢猫 / 我超爱火锅 / 我爱打游戏
  { cat: 'preference', re: /我(?:很|最|超|特别|有点|真的)?(?:喜欢|爱|偏爱|迷|在追|在玩|在学)([^\s，。！？,.!?]{1,20})/g, text: (m) => `对方喜欢${m[1]}` },
  // 雷点：我不吃辣 / 我讨厌烟味 / 我对海鲜过敏
  { cat: 'dislike', re: /我(?:不吃|不能吃|忌口)([^\s，。！？,.!?]{1,20})/g, text: (m) => `对方不吃${m[1]}` },
  { cat: 'dislike', re: /我(?:很|最|超|特别)?(讨厌|烦|受不了|怕)([^\s，。！？,.!?]{1,20})/g, text: (m) => `对方${m[1]}${m[2]}` },
  { cat: 'dislike', re: /我对([^\s，。！？,.!?]{1,10})过敏/g, text: (m) => `对方对${m[1]}过敏` },
  // 宠物：我养了只猫 / 我家有只狗
  { cat: 'relation', re: /我(?:家)?(?:养了|有)(?:一)?只([^\s，。！？,.!?]{1,8})/g, text: (m) => `对方养了${m[1]}` },
  // 计划：我明天要去考试 / 我周末打算爬山
  { cat: 'plan', re: /我(?:明天|后天|周末|下周|今晚|待会|最近)(?:要|打算|准备|计划|想)([^\s，。！？,.!?]{2,20})/g, text: (m) => `对方${m[0].slice(1)}` },
];

function clean(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?；;：:~]+$/g, '')
    .slice(0, MAX_FACT_CHARS);
}

/** 归一化用于判重：去掉标点和空白，只比内容。 */
export function factKey(text) {
  return String(text ?? '').replace(/[\s，。！？、,.!?；;：:（）()【】\[\]]/g, '').toLowerCase();
}

/**
 * 从一条消息里提炼事实候选。
 * @param {string} text 对方发来的原文
 * @param {{max?:number}} opts
 * @returns {{cat:string, text:string}[]}
 */
export function extractFacts(text, { max = 3 } = {}) {
  const raw = String(text ?? '').trim();
  // 太短没信息量；太长（转发的长文）容易误伤，只取前 160 字判断。
  if (raw.length < 4) return [];
  const src = raw.slice(0, 160);
  const found = [];
  const seen = new Set();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src))) {
      const t = clean(rule.text(m));
      if (!t || t.length < 3) continue;
      const key = factKey(t);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ cat: rule.cat, text: t });
      if (found.length >= max) return found;
    }
  }
  return found;
}

/** 事实文件路径。 */
export function factsFile(rootDir, role) {
  return path.join(rootDir, 'state', sanitizeRoleName(role), FACTS_FILE);
}

function parseLines(raw) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed);
      if (item && typeof item.text === 'string' && item.text) out.push(item);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

/**
 * 追加一条事实。同一人格里内容相同（归一化后）就不再写。
 * @returns {{ok:boolean, skipped?:string, entry?:object}}
 */
export function appendFact(rootDir, { role, text, cat = 'identity', conv = '', source = 'auto', at = Date.now() } = {}) {
  const r = sanitizeRoleName(role);
  const t = clean(text);
  if (!r) return { ok: false, skipped: 'no-role' };
  if (!t) return { ok: false, skipped: 'empty' };
  const file = factsFile(rootDir, r);
  let existing = [];
  try {
    existing = parseLines(fs.readFileSync(file, 'utf8'));
  } catch {
    /* 首条 */
  }
  const key = factKey(t);
  if (existing.some((e) => factKey(e.text) === key)) return { ok: true, skipped: 'duplicate' };

  const record = {
    at: Number(at) || Date.now(),
    role: r,
    cat: CAT_LABEL[cat] ? cat : 'identity',
    text: t,
    conv: String(conv ?? ''),
    source: String(source ?? 'auto'),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');

  // 上限：超了只留最新的 FACTS_MAX 条（新的通常更有用）。
  const all = [...existing, record];
  if (all.length > FACTS_MAX) {
    const kept = all.slice(-FACTS_MAX);
    fs.writeFileSync(file, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
  }
  return { ok: true, entry: record };
}

/** 读某人格全部事实。 */
export function readFacts(rootDir, role) {
  let raw = '';
  try {
    raw = fs.readFileSync(factsFile(rootDir, role), 'utf8');
  } catch {
    return [];
  }
  return parseLines(raw);
}

/** 按身份/内容删一条（at + text 定位；传了 conv 就只删那个会话窗口里的）。 */
export function removeFact(rootDir, role, { at, text, conv } = {}) {
  const file = factsFile(rootDir, role);
  const all = readFacts(rootDir, role);
  const kept = all.filter((e) => !(
    Number(e.at) === Number(at)
    && factKey(e.text) === factKey(text)
    && (conv === undefined || !e.conv || String(e.conv ?? '') === String(conv))
  ));
  if (kept.length === all.length) return { ok: false, error: '没有这条事实' };
  fs.writeFileSync(file, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
  return { ok: true, removed: all.length - kept.length };
}

/** 关键词召回（事实数量少，直接复用日记的打分）。 */
export function searchFacts(facts, query, { limit = 3 } = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const scored = [];
  for (const f of facts) {
    const hay = String(f.text ?? '').toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += t.length > 1 ? 2 : 1;
    if (score > 0) scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score || (Number(b.f.at) || 0) - (Number(a.f.at) || 0));
  return scored.slice(0, limit).map((s) => s.f);
}

/**
 * 组装「长期事实」注入块。按类别权重 + 新旧排序，整块不超过预算。
 * @returns {{block:string, chars:number, used:number}}
 */
export function buildFactsBlock({ facts = [], related = [], now = Date.now(), budgetChars = DEFAULT_FACTS_INJECT_CHARS } = {}) {
  const seen = new Set();
  const merged = [];
  for (const f of [...facts, ...related]) {
    const key = factKey(f?.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }
  // 身份 > 雷点 > 喜好 > 关系 > 计划；同类按时间新。
  const weight = { identity: 5, dislike: 4, preference: 3, relation: 2, plan: 1 };
  merged.sort((a, b) => (weight[b.cat] ?? 0) - (weight[a.cat] ?? 0) || (Number(b.at) || 0) - (Number(a.at) || 0));
  const budget = Math.max(80, Number(budgetChars) || DEFAULT_FACTS_INJECT_CHARS);
  const lines = [];
  let chars = 0;
  for (const f of merged) {
    const label = CAT_LABEL[f.cat] ?? '事实';
    const line = `- ${label}：${f.text}`;
    if (chars + line.length + 1 > budget) continue;
    lines.push(line);
    chars += line.length + 1;
  }
  if (!lines.length) return { block: '', chars: 0, used: 0 };
  return { block: `【长期事实 · 用户画像】\n${lines.join('\n')}\n\n`, chars, used: lines.length };
}
