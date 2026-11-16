// Markdown 视图层：把 jsonl 里的日记/档案，按「会话窗口」渲染成可直接用记事本打开的 .md。
//
// 为什么单独一层、而不是把 jsonl 换成 md：
//   jsonl 是机器存储（去重、删除、轮转、按字段检索都靠它），md 是给人看的视图。
//   两边职责分开，改视图不影响注入，改存储也不会把人的阅读习惯弄丢。
//
// 三条约定：
//   1. 只写 md、从不回读：注入逻辑永远读 jsonl，md 坏了删掉重建即可；
//   2. 一个会话窗口一个文件：diary/private-<号>.md、diary/group-<号>.md，找人找事都按文件夹找；
//   3. 档案按天分：archive/<窗口>/<YYYY-MM-DD>.md，一天一个文件，便于长期归档。
import fs from 'node:fs';
import path from 'node:path';

/** 日记视图子目录。 */
export const MD_DIARY_DIR = 'diary';
/** 档案视图子目录。 */
export const MD_ARCHIVE_DIR = 'archive';

/** 日记类型的中文标签，保留在行首方括号里（用户 2026-11-16 要求保留 kind 前缀）。 */
export const KIND_TAG = {
  topic: '话题',
  thought: '念头',
  impression: '印象',
  event: '事件',
  handoff: '交接',
  self: '自记',
};

/** 档案动作标签。 */
export const ACTION_TAG = {
  write: '写入',
  delete: '删除',
  rotate: '轮转',
};

/** 长期事实的分类标签（档案里 fact 条目用它，而不是日记的 kind）。 */
export const FACT_TAG = {
  identity: '身份',
  preference: '喜好',
  dislike: '雷点',
  relation: '关系',
  plan: '计划',
};

/** 未知类型统一显示成「其他」，避免出现 undefined。 */
export function kindTag(kind) {
  return KIND_TAG[String(kind ?? '')] ?? '其他';
}

/** 会话 key → 文件名片段：`private:1932831443` → `private-1932831443`。 */
export function scopeSlug(scope) {
  const raw = String(scope ?? '').trim();
  if (!raw) return 'unsorted';
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'unsorted';
}

function safeRole(role) {
  return String(role ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, 60);
}

/** 某个会话窗口的日记视图文件路径。 */
export function diaryMdFile(rootDir, role, scope) {
  return path.join(rootDir, 'state', safeRole(role), MD_DIARY_DIR, `${scopeSlug(scope)}.md`);
}

/** 某个会话窗口某一天的档案视图文件路径。 */
export function archiveMdFile(rootDir, role, scope, date) {
  return path.join(rootDir, 'state', safeRole(role), MD_ARCHIVE_DIR, scopeSlug(scope), `${date}.md`);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间 HH:MM。 */
export function clock(at) {
  const d = new Date(Number(at) || Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本地时间 YYYY-MM-DD（视图文件按本地日期分，跟人看的“今天”一致）。 */
export function localDay(at) {
  const d = new Date(Number(at) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 压成单行：md 是给人扫的，一条记忆一行。 */
function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 渲染一份日记视图。entries 需含 { at, kind, text }。 */
export function renderDiaryMd({ role, scope, entries = [], now = Date.now() } = {}) {
  const rows = [...entries].sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0));
  const lines = [
    `# ${role || '角色'} 的日记 · ${scope || '未分类'}`,
    '',
    `> 由 diary.jsonl 自动生成，改这里不会回写；共 ${rows.length} 条，生成于 ${new Date(now).toISOString()}。`,
    '',
  ];
  for (const e of rows) {
    lines.push(`- ${clock(e?.at)} [${kindTag(e?.kind)}] ${oneLine(e?.text)}`);
  }
  if (!rows.length) lines.push('_（还没有记录）_');
  return `${lines.join('\n')}\n`;
}

/** 渲染一份档案视图。entries 需含 { at, action, kind, text | 事实对象 }。 */
export function renderArchiveMd({ role, scope, date, entries = [], now = Date.now() } = {}) {
  const rows = [...entries].sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0));
  const lines = [
    `# ${role || '角色'} 的档案 · ${scope || '未分类'} · ${date || ''}`.trim(),
    '',
    `> 由档案层自动生成，只写不读；共 ${rows.length} 条，生成于 ${new Date(now).toISOString()}。`,
    '',
  ];
  for (const e of rows) {
    const action = ACTION_TAG[String(e?.action ?? '')] ?? '写入';
    const rawKind = e?.entryKind ?? e?.entry?.kind;
    let kind;
    if (e?.kind === 'fact' && rawKind) kind = FACT_TAG[String(rawKind)] ?? '事实';
    else if (rawKind) kind = kindTag(rawKind);
    else kind = e?.kind === 'fact' ? '事实' : e?.kind === 'diary' ? '日记' : '其他';
    const text = oneLine(e?.text ?? e?.entry?.text ?? '');
    lines.push(`- ${clock(e?.at)} [${action}][${kind}] ${text}`);
  }
  if (!rows.length) lines.push('_（这一天没有记录）_');
  return `${lines.join('\n')}\n`;
}

/** 原子写：先写临时文件再 rename，避免同步脚本读到半截文件。 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 按窗口把日记分组。 */
export function groupDiaryByScope(entries = []) {
  const map = new Map();
  for (const e of entries) {
    const scope = String(e?.conv ?? '').trim();
    const key = scopeSlug(scope);
    if (!map.has(key)) map.set(key, { scope, entries: [] });
    map.get(key).entries.push(e);
  }
  return map;
}

/** 按「窗口 + 日期」把档案分组。 */
export function groupArchiveByScopeDay(entries = []) {
  const map = new Map();
  for (const e of entries) {
    const scope = String(e?.conv ?? e?.entry?.conv ?? '').trim();
    const date = localDay(e?.at);
    const key = `${scopeSlug(scope)}|${date}`;
    if (!map.has(key)) map.set(key, { scope, date, entries: [] });
    map.get(key).entries.push(e);
  }
  return map;
}

/**
 * 重建某角色的日记视图（每个窗口一个 md）。
 * @returns {{files:string[], count:number}}
 */
export function writeDiaryViews(rootDir, role, entries = [], { now = Date.now() } = {}) {
  const groups = groupDiaryByScope(entries);
  const files = [];
  for (const { scope, entries: list } of groups.values()) {
    const file = diaryMdFile(rootDir, role, scope);
    writeAtomic(file, renderDiaryMd({ role, scope, entries: list, now }));
    files.push(file);
  }
  return { files, count: entries.length };
}

/**
 * 重建某角色的档案视图（每个窗口、每天一个 md）。
 * @returns {{files:string[], count:number}}
 */
export function writeArchiveViews(rootDir, role, entries = [], { now = Date.now() } = {}) {
  const groups = groupArchiveByScopeDay(entries);
  const files = [];
  for (const { scope, date, entries: list } of groups.values()) {
    const file = archiveMdFile(rootDir, role, scope, date);
    writeAtomic(file, renderArchiveMd({ role, scope, date, entries: list, now }));
    files.push(file);
  }
  return { files, count: entries.length };
}
