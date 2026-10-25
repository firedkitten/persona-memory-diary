// 事件日记（P2）：把「发生过什么」按人格落盘成 JSONL，并在唤醒时取最近 + 相关几条注入。
//
// 和轻量记忆（bridge 里的 topics/thoughts/impressions）的分工：
//   轻量记忆 = 此刻的短期状态，2 小时就过期，回答"现在在聊什么"；
//   日记     = 长期的锚，不过期，回答"我们之间发生过什么、答应过什么"。
//   上下文被压缩时，最先没的是后者；所以它必须落盘、必须每轮带一小段回来。
//
// 设计约束（与整包一致）：
//   1. 一人格一文件：state/<人格>/diary.jsonl，不串人格；
//   2. 纯 JSONL，追加写，不引数据库；超过阈值自动轮转（保留最新一段），文件不会无限涨；
//   3. 只读入参是文件与纯数据，方便单测；写盘函数显式接收 rootDir。
import fs from 'node:fs';
import path from 'node:path';

import { appendArchive, appendArchives } from './archive.js';

/** 日记文件名（每个人格一个）。 */
export const DIARY_FILE = 'diary.jsonl';
/** 单条正文上限（字符）：日记是锚不是聊天记录，只留结论。 */
export const MAX_TEXT_CHARS = 200;
/** 注入默认预算（字符）。约 200~300 token。 */
export const DEFAULT_INJECT_CHARS = 400;
/** 同一条内容在 10 分钟内重复写入视为重复（AI 经常一口气写好几次）。 */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/** 文件超过 1MB 时轮转，只保留最新 3000 行。 */
export const ROTATE_BYTES = 1024 * 1024;
export const KEEP_LINES = 3000;

/** 类别 → 日记里的短标签。 */
const KIND_LABEL = {
  topic: '话题',
  thought: '念头',
  impression: '印象',
  event: '事件',
  handoff: '交接',
};

/** 与桥接 sanitizeRoleName 同一规则：只留字母数字下划线中文与连字符。 */
export function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

/** 日记文件路径。role 已消毒；rootDir 是 memory-diary 目录（其下建 state/）。 */
export function diaryFile(rootDir, role) {
  return path.join(rootDir, 'state', sanitizeRoleName(role), DIARY_FILE);
}

/** 把任意时间戳格式化成「刚刚 / 5分钟前 / 3小时前 / 2天前」。 */
export function formatRelative(at, now = Date.now()) {
  const ms = Number(at) || 0;
  if (!ms) return '时间未知';
  const diff = Math.max(0, Number(now) - ms);
  const minute = 60 * 1000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)}分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}小时前`;
  return `${Math.floor(diff / (24 * 60 * minute))}天前`;
}

/** 逐行解析，坏行跳过（宁可少一条，不要让一条坏数据把整份日记读崩）。 */
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
 * 追加一条日记。
 * @param {string} rootDir memory-diary 目录
 * @param {{role:string, conv?:string, kind?:string, text:string, extra?:object, imp?:number, at?:number}} entry
 * @returns {{ok:boolean, skipped?:string, entry?:object}}
 */
export function appendDiary(rootDir, entry, { rotateBytes = ROTATE_BYTES, keepLines = KEEP_LINES } = {}) {
  const role = sanitizeRoleName(entry?.role);
  const text = String(entry?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  if (!role) return { ok: false, skipped: 'no-role' };
  if (!text) return { ok: false, skipped: 'empty' };

  const file = diaryFile(rootDir, role);
  const at = Number(entry.at) || Date.now();
  const record = {
    at,
    role,
    conv: String(entry.conv ?? ''),
    kind: KIND_LABEL[entry.kind] ? String(entry.kind) : 'event',
    text,
    imp: Math.min(5, Math.max(1, Number(entry.imp) || 2)),
    ...(entry.extra && typeof entry.extra === 'object' ? { extra: entry.extra } : {}),
  };

  // 重复判定只看最后几条：同一句话连写三遍是常态，不能记三遍。
  let existing = [];
  try {
    existing = parseLines(fs.readFileSync(file, 'utf8')).slice(-50);
  } catch {
    /* 文件不存在 = 首条 */
  }
  const dup = existing
    .filter((e) => e.conv === record.conv && e.text === record.text)
    .some((e) => Math.abs(at - (Number(e.at) || 0)) < DEDUPE_WINDOW_MS);
  if (dup) return { ok: true, skipped: 'duplicate' };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  appendArchive(rootDir, { role, kind: 'diary', action: 'write', entry: record });

  // 轮转：按体积触发（每次 stat 比每次数行便宜），保留最新 keepLines 行。
  try {
    const size = fs.statSync(file).size;
    if (size > rotateBytes) {
      const all = parseLines(fs.readFileSync(file, 'utf8'));
      const kept = all.slice(-keepLines);
      const dropped = all.slice(0, Math.max(0, all.length - kept.length));
      // 轮转丢掉的是旧事，不是没发生过——先入档案，再从工作文件里移除。
      if (dropped.length) appendArchives(rootDir, role, 'diary', 'rotate', dropped);
      fs.writeFileSync(file, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
    }
  } catch {
    /* 轮转失败不影响本次写入 */
  }
  return { ok: true, entry: record };
}

/** 读某人格全部日记（按时间正序）。 */
export function readDiary(rootDir, role, { limit = 0 } = {}) {
  const file = diaryFile(rootDir, role);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const all = parseLines(raw).sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  return limit > 0 ? all.slice(-limit) : all;
}

/** 查询词切分：中文取二元组（"火锅" → 火/锅/火锅），英文数字按词。 */
export function queryTerms(query) {
  const q = String(query ?? '').toLowerCase();
  const terms = new Set();
  for (const m of q.match(/[a-z0-9_]{2,}/g) ?? []) terms.add(m);
  const cjk = (q.match(/[\u4e00-\u9fff]+/g) ?? []).join('');
  for (let i = 0; i < cjk.length; i += 1) {
    terms.add(cjk[i]);
    if (i + 1 < cjk.length) terms.add(cjk.slice(i, i + 2));
  }
  return [...terms];
}

/** 关键词召回：命中词数优先，同分按时间新。 */
export function searchDiary(entries, query, { limit = 3 } = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const scored = [];
  for (const e of entries) {
    const hay = `${e.text ?? ''} ${e.extra?.target ?? ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += t.length > 1 ? 2 : 1;
    if (score > 0) scored.push({ entry: e, score });
  }
  scored.sort((a, b) => b.score - a.score || (Number(b.entry.at) || 0) - (Number(a.entry.at) || 0));
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * 组装注入块。最近 + 相关合并去重，按时间倒序，整块不超过预算。
 * @returns {{ block: string, chars: number, used: number }}
 */
export function buildDiaryBlock({ recent = [], related = [], now = Date.now(), budgetChars = DEFAULT_INJECT_CHARS } = {}) {
  const seen = new Set();
  const merged = [];
  for (const e of [...recent, ...related]) {
    const key = `${e.at}|${e.text}`;
    if (!e?.text || seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  merged.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  const budget = Math.max(80, Number(budgetChars) || DEFAULT_INJECT_CHARS);

  const lines = [];
  let chars = 0;
  for (const e of merged) {
    const label = KIND_LABEL[e.kind] ?? '事件';
    const line = `- ${formatRelative(e.at, now)} · ${label}：${e.text}`;
    if (chars + line.length + 1 > budget) continue;
    lines.push(line);
    chars += line.length + 1;
  }
  if (!lines.length) return { block: '', chars: 0, used: 0 };
  const block = `【日记 · 记忆锚点】\n${lines.join('\n')}\n\n`;
  return { block, chars, used: lines.length };
}

/** 按时间戳 + 内容删一条日记（控制台用）。传了 conv 就只删那个会话窗口里的那条。 */
export function removeDiary(rootDir, role, { at, text, conv } = {}) {
  const file = diaryFile(rootDir, role);
  const all = readDiary(rootDir, role);
  const dropped = all.filter((e) => (
    Number(e.at) === Number(at)
    && String(e.text ?? '') === String(text ?? '')
    && (conv === undefined || !e.conv || String(e.conv ?? '') === String(conv))
  ));
  if (!dropped.length) return { ok: false, error: '没有这条日记' };
  // 先留档再删：删掉的条目仍然可查，只是不再参与注入。
  appendArchives(rootDir, role, 'diary', 'delete', dropped);
  const kept = all.filter((e) => !dropped.includes(e));
  fs.writeFileSync(file, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
  return { ok: true, removed: dropped.length };
}