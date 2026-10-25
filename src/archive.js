// 档案留存（append-only）：事实/日记的每一次写入、删除、轮转都留一份底稿。
//
// 为什么单独一层：
//   事实有 200 条上限、日记有 1MB 轮转、控制台还能删条目。这些"清理"本身是对的
//   （注入预算不能涨），但它们会让旧事真的消失。档案层只追加、从不读取、也从不
//   被注入对话——它只解决一件事：删掉的东西还能找回来。
//
// 三条硬规矩：
//   1. 只写不读：唤醒注入只读 facts.jsonl / diary.jsonl，永远不碰 archive/；
//   2. 一个人格一个目录：state/<人格>/archive/，跟记忆文件放一起，打包迁移时跟着走；
//   3. 按天分文件：<kind>-YYYY-MM-DD.jsonl（日期固定按 UTC+8 算，避免服务器时区漂移）。
import fs from 'node:fs';
import path from 'node:path';

/** 档案子目录名。 */
export const ARCHIVE_DIR = 'archive';
/** 支持的档案类型。 */
export const ARCHIVE_KINDS = ['fact', 'diary'];
/** 动作：写入 / 删除 / 轮转淘汰。 */
export const ARCHIVE_ACTIONS = ['write', 'delete', 'rotate'];
/** 时区偏移（分钟）：按东八区切日，跟使用者的"今天"对齐。 */
const TZ_OFFSET_MIN = 8 * 60;

function safeRole(role) {
  return String(role ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+$/, '').trim().slice(0, 60);
}

/** 某人格的档案目录。 */
export function archiveDir(rootDir, role) {
  return path.join(rootDir, 'state', safeRole(role), ARCHIVE_DIR);
}

/** 记录时间戳属于哪一天（UTC+8，形如 2026-10-25）。 */
export function archiveDay(at) {
  const ms = Number(at) || Date.now();
  return new Date(ms + TZ_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** 某一天某类档案的文件路径。 */
export function archiveFile(rootDir, role, kind, at) {
  const k = ARCHIVE_KINDS.includes(kind) ? kind : 'fact';
  return path.join(archiveDir(rootDir, role), `${k}-${archiveDay(at)}.jsonl`);
}

/**
 * 追加档案。失败不抛（档案是旁路，不能影响主流程）。
 * @returns {{ok:boolean, file?:string, error?:string}}
 */
export function appendArchive(rootDir, { role, kind, action = 'write', entry = {}, at } = {}) {
  try {
    const r = safeRole(role);
    if (!r) return { ok: false, error: 'no-role' };
    const k = ARCHIVE_KINDS.includes(kind) ? kind : null;
    if (!k) return { ok: false, error: 'bad-kind' };
    const ts = Number(at ?? entry.at) || Date.now();
    const file = archiveFile(rootDir, r, k, ts);
    const line = {
      ...entry,
      at: Number(entry.at) || ts,
      archivedAt: new Date().toISOString(),
      action: ARCHIVE_ACTIONS.includes(action) ? action : 'write',
      kind: k,
      role: r,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** 批量追加（轮转淘汰时一次写很多条）。 */
export function appendArchives(rootDir, role, kind, action, entries = []) {
  let written = 0;
  for (const entry of entries) {
    if (appendArchive(rootDir, { role, kind, action, entry }).ok) written += 1;
  }
  return { ok: true, written };
}

function parseLines(raw) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 坏行跳过：档案允许残缺，不允许整份读不出来 */
    }
  }
  return out;
}

/** 列出某人档案里有哪些天、各多少条（控制台用，不参与注入）。 */
export function listArchive(rootDir, role) {
  const dir = archiveDir(rootDir, role);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = /^(fact|diary)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    let count = 0;
    try {
      count = parseLines(fs.readFileSync(path.join(dir, name), 'utf8')).length;
    } catch {
      continue;
    }
    if (count > 0) out.push({ kind: m[1], date: m[2], count });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.kind.localeCompare(b.kind)));
  return out;
}

/** 读某人某天某类的档案（倒序：新的在前）。 */
export function readArchive(rootDir, role, { kind = 'fact', date } = {}) {
  const k = ARCHIVE_KINDS.includes(kind) ? kind : 'fact';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) ? date : archiveDay(Date.now());
  const file = path.join(archiveDir(rootDir, role), `${k}-${day}.jsonl`);
  try {
    return parseLines(fs.readFileSync(file, 'utf8')).reverse();
  } catch {
    return [];
  }
}

/** 档案总条数（控制台角标用）。 */
export function archiveStats(rootDir, role) {
  const days = listArchive(rootDir, role);
  return {
    days: days.length,
    entries: days.reduce((n, d) => n + d.count, 0),
    byKind: {
      fact: days.filter((d) => d.kind === 'fact').reduce((n, d) => n + d.count, 0),
      diary: days.filter((d) => d.kind === 'diary').reduce((n, d) => n + d.count, 0),
    },
  };
}
