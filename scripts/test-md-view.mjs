// md 视图层单测：按窗口分文件、kind 前缀保留、档案按天分、原子写不留 .tmp。
// 跑法：node scripts/test-md-view.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveMdFile,
  diaryMdFile,
  groupArchiveByScopeDay,
  groupDiaryByScope,
  kindTag,
  renderArchiveMd,
  renderDiaryMd,
  scopeSlug,
  writeArchiveViews,
  writeDiaryViews,
} from '../src/md-view.js';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-view-test-'));
const role = '阿橘';
const at = (h, m = 0) => new Date(2026, 10, 16, h, m, 0).getTime();

console.log('md 视图层');

ok('会话 key 转文件名', () => {
  assert.equal(scopeSlug('private:1932831443'), 'private-1932831443');
  assert.equal(scopeSlug('group:1129256216'), 'group-1129256216');
  assert.equal(scopeSlug(''), 'unsorted');
  assert.equal(scopeSlug('  '), 'unsorted');
});

ok('kind 中文前缀，未知归“其他”', () => {
  assert.equal(kindTag('impression'), '印象');
  assert.equal(kindTag('handoff'), '交接');
  assert.equal(kindTag('nonsense'), '其他');
  assert.equal(kindTag(undefined), '其他');
});

ok('日记 md：按时间排序、保留 [kind] 前缀', () => {
  const text = renderDiaryMd({
    role,
    scope: 'private:1932831443',
    entries: [
      { at: at(9, 30), kind: 'event', text: '一起给猫起名' },
      { at: at(8, 5), kind: 'topic', text: '聊到\n搬家 的事' },
    ],
  });
  assert.match(text, /^# 阿橘 的日记 · private:1932831443/);
  const lines = text.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '- 08:05 [话题] 聊到 搬家 的事');
  assert.equal(lines[1], '- 09:30 [事件] 一起给猫起名');
});

ok('空日记也给出可读提示', () => {
  const text = renderDiaryMd({ role, scope: '', entries: [] });
  assert.match(text, /未分类/);
  assert.match(text, /还没有记录/);
});

ok('日记视图按窗口分文件，互不串数据', () => {
  const entries = [
    { at: at(9), kind: 'event', text: '私聊里的事', conv: 'private:1932831443' },
    { at: at(10), kind: 'event', text: '群窗口里的事', conv: 'group:1129256216' },
    { at: at(11), kind: 'topic', text: '没有窗口的旧数据', conv: '' },
  ];
  const { files } = writeDiaryViews(root, role, entries);
  assert.equal(files.length, 3);
  const priv = fs.readFileSync(diaryMdFile(root, role, 'private:1932831443'), 'utf8');
  const group = fs.readFileSync(diaryMdFile(root, role, 'group:1129256216'), 'utf8');
  const orphan = fs.readFileSync(diaryMdFile(root, role, ''), 'utf8');
  assert.match(priv, /私聊里的事/);
  assert.doesNotMatch(priv, /群窗口里的事/);
  assert.match(group, /群窗口里的事/);
  assert.match(orphan, /没有窗口的旧数据/);
});

ok('档案视图按「窗口 + 日期」分文件，带动作标签', () => {
  const entries = [
    { at: at(9), kind: 'diary', entryKind: 'topic', action: 'write', text: '记了一条日记', conv: 'group:1129256216' },
    { at: at(9, 20), kind: 'fact', entryKind: 'preference', action: 'write', text: '对方不吃辣', conv: 'group:1129256216' },
    { at: at(15), kind: 'diary', entryKind: 'event', action: 'delete', text: '删掉的那条', conv: 'group:1129256216' },
  ];
  const { files } = writeArchiveViews(root, role, entries);
  assert.equal(files.length, 1);
  const date = new Date(at(9)).toLocaleDateString('sv-SE'); // YYYY-MM-DD
  const text = fs.readFileSync(archiveMdFile(root, role, 'group:1129256216', date), 'utf8');
  assert.match(text, /\[写入\]\[话题\] 记了一条日记/);
  assert.match(text, /\[写入\]\[喜好\] 对方不吃辣/);
  assert.match(text, /\[删除\]\[事件\] 删掉的那条/);
  const lines = text.split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(lines.map((l) => l.slice(2, 7)), ['09:00', '09:20', '15:00']);
});

ok('分组函数：窗口/日期维度正确', () => {
  const byScope = groupDiaryByScope([
    { at: at(9), conv: 'private:1', text: 'a' },
    { at: at(10), conv: 'private:1', text: 'b' },
  ]);
  assert.equal(byScope.size, 1);
  assert.equal(byScope.get('private-1').entries.length, 2);
  const byDay = groupArchiveByScopeDay([
    { at: at(23), conv: 'group:9', text: 'x' },
    { at: at(1), conv: 'group:9', text: 'y' },
  ]);
  assert.equal(byDay.size, 1);
});

ok('原子写不留 .tmp，重复渲染幂等', () => {
  const entries = [{ at: at(9), kind: 'event', text: '同一件事', conv: 'private:7' }];
  const now = at(12);
  writeDiaryViews(root, role, entries, { now });
  const file = diaryMdFile(root, role, 'private:7');
  const first = fs.readFileSync(file, 'utf8');
  writeDiaryViews(root, role, entries, { now });
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  const dir = path.dirname(file);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(passed === 8 ? `\n通过 ${passed} 项` : `\n通过 ${passed} 项（有失败）`);
