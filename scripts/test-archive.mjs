// 档案留存（archive.js）＋ 事实/日记的留档挂钩 单测。
//
// 覆盖：写入留档、删除留档、轮转/上限淘汰留档、按天分文件（UTC+8 切日）、
// 只写不读（档案不进注入）、坏行容错。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ARCHIVE_DIR, appendArchive, appendArchives, archiveDay, archiveDir, archiveFile,
  archiveStats, listArchive, readArchive,
} from '../src/archive.js';
import { appendDiary, removeDiary, diaryFile } from '../src/diary.js';
import { appendFact, removeFact, factsFile } from '../src/facts.js';
import { FACTS_MAX } from '../src/facts.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
}

test('日期按 UTC+8 切日：23:30 +08 与 00:30 +08 落在不同的两天', () => {
  // 2026-10-25T15:30Z = 2026-10-25 23:30 (+08)；2026-10-25T17:30Z = 2026-10-26 01:30 (+08)
  assert.equal(archiveDay(Date.parse('2026-10-25T15:30:00Z')), '2026-10-25');
  assert.equal(archiveDay(Date.parse('2026-10-25T17:30:00Z')), '2026-10-26');
});

test('写入日记会留档，档案按 diary-YYYY-MM-DD.jsonl 落盘', () => {
  const root = tmpRoot();
  const at = Date.parse('2026-10-25T12:00:00Z');
  const r = appendDiary(root, { role: '阿橘', conv: 'private:1', kind: 'event', text: '一起给猫起了名字', at });
  assert.equal(r.ok, true);
  const file = archiveFile(root, '阿橘', 'diary', at);
  assert.ok(fs.existsSync(file), '档案文件应存在');
  assert.ok(file.endsWith(`diary-${archiveDay(at)}.jsonl`));
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'write');
  assert.equal(rows[0].text, '一起给猫起了名字');
  assert.equal(rows[0].role, '阿橘');
});

test('删除日记：工作文件里没了，档案里留了一条 delete', () => {
  const root = tmpRoot();
  const at = Date.parse('2026-10-25T12:00:00Z');
  appendDiary(root, { role: '阿橘', conv: 'private:1', kind: 'event', text: '临时记错的一条', at });
  const del = removeDiary(root, '阿橘', { at, text: '临时记错的一条', conv: 'private:1' });
  assert.equal(del.ok, true);

  const live = fs.readFileSync(diaryFile(root, '阿橘'), 'utf8').trim();
  assert.equal(live, '', '工作文件应被清空');
  const rows = readArchive(root, '阿橘', { kind: 'diary', date: archiveDay(at) });
  assert.equal(rows.length, 2, '应有一条 write 和一条 delete');
  assert.deepEqual(rows.map((r) => r.action).sort(), ['delete', 'write']);
});

test('写入事实会留档，删除事实也会留档', () => {
  const root = tmpRoot();
  const at = Date.parse('2026-10-25T12:00:00Z');
  appendFact(root, { role: '阿橘', text: '对方不吃香菜', cat: 'dislike', conv: 'private:1', at });
  appendFact(root, { role: '阿橘', text: '对方不吃香菜', cat: 'dislike', conv: 'private:1', at }); // 重复，不该再留档
  const rows = readArchive(root, '阿橘', { kind: 'fact', date: archiveDay(at) });
  assert.equal(rows.length, 1, '重复事实不重复留档');

  removeFact(root, '阿橘', { at, text: '对方不吃香菜', conv: 'private:1' });
  const after = readArchive(root, '阿橘', { kind: 'fact', date: archiveDay(at) });
  assert.equal(after.length, 2);
  assert.equal(after[0].action, 'delete', '倒序读，最新的在前');
});

test('事实超上限被挤掉的条目进档案，且 action=rotate', () => {
  const root = tmpRoot();
  const base = Date.parse('2026-10-25T00:00:00Z');
  for (let i = 0; i < FACTS_MAX + 2; i += 1) {
    appendFact(root, { role: '阿橘', text: `第 ${i} 条事实`, cat: 'identity', at: base + i * 1000 });
  }
  const rows = readArchive(root, '阿橘', { kind: 'fact', date: archiveDay(base + FACTS_MAX * 1000) });
  const rotated = rows.filter((r) => r.action === 'rotate');
  assert.equal(rotated.length, 2, `应有 2 条被挤掉，实际 ${rotated.length}`);
  assert.ok(rotated.some((r) => r.text === '第0条事实'), '最旧的一条应在档案里（写入时空白已被清掉）');
});

test('档案只写不读：listArchive 能列出，但注入块与 readDiary 不受影响', () => {
  const root = tmpRoot();
  const at = Date.parse('2026-10-25T12:00:00Z');
  appendDiary(root, { role: '阿橘', kind: 'event', text: '换了个话题', at });
  appendArchive(root, {
    role: '阿橘', kind: 'diary', action: 'write', at,
    entry: { at, role: '阿橘', conv: '', kind: 'event', text: '只在档案里的一条' },
  });
  const days = listArchive(root, '阿橘');
  assert.equal(days.length, 1);
  assert.equal(days[0].count, 2);

  const stats = archiveStats(root, { role: '阿橘' }.role);
  assert.equal(stats.entries, 2);
  assert.equal(stats.byKind.diary, 2);
  const live = fs.readFileSync(diaryFile(root, '阿橘'), 'utf8');
  assert.ok(!live.includes('只在档案里的一条'), '档案内容不能回流到工作文件');
});

test('bad 参数与坏行不抛：空角色、非法 kind、缺文件都返回安全值', () => {
  const root = tmpRoot();
  assert.equal(appendArchive(root, { role: '', kind: 'fact' }).ok, false);
  assert.equal(appendArchive(root, { role: '阿橘', kind: 'nope' }).ok, false);
  assert.deepEqual(readArchive(root, '阿橘', { kind: 'diary', date: '2026-01-01' }), []);
  assert.deepEqual(listArchive(root, '不存在的人'), []);
  assert.deepEqual(appendArchives(root, '阿橘', 'fact', 'delete', []), { ok: true, written: 0 });

  // 手工塞一行坏 JSON，读档案时应跳过而不是整份失败
  const dir = archiveDir(root, '阿橘');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fact-2026-01-01.jsonl'), '{坏行\n', 'utf8');
  assert.deepEqual(readArchive(root, '阿橘', { kind: 'fact', date: '2026-01-01' }), []);
  assert.equal(ARCHIVE_DIR, 'archive');
});
