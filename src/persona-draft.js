// 人格内核自动草稿：从 roles/<角色>.md 里抽「压缩后不能丢」的骨架，生成 persona-core/<角色>.md。
//
// 为什么要有它：
//   每建一个人格就手写一份内核，长期没人扛得住；但完全不写，压缩后又没有锚。
//   所以折中：**机器先出草稿**（只摘录角色卡原文，不编造），人再改两句。
//
// 抽取原则（宁可空着，不可乱写）：
//   1. 只按小标题归类，不猜语义；归不了类的行直接丢；
//   2. 每类最多留 2 行、每行 ≤160 字，超了截断；
//   3. 一类都没抽到 → 退化成「角色卡开头几行」，并在 warnings 里说明；
//   4. 生成物带 `generated: true` 与 `sourceHash`，角色卡改了能看出内核已过期。
import { createHash } from 'node:crypto';

/** 生成的正文上限（字符），与 PERSONA_CORE_MAX_CHARS 一致。 */
export const DRAFT_MAX_CHARS = 600;

/** 分类 → 展示用的小标题。 */
const CAT_LABEL = {
  identity: '身份',
  address: '称呼',
  tone: '说话',
  taboo: '禁区',
};

/**
 * 小标题关键词 → 分类。按顺序匹配，先命中先算。
 * 只认标题，不认正文，避免把"我不喜欢被叫老师"这种句子误当成禁区整节。
 */
const TITLE_RULES = [
  { cat: 'identity', re: /身份|你是谁|我是谁|人设|设定|背景|名字|自我介绍/ },
  { cat: 'address', re: /称呼|叫对方|怎么叫|叫我|称谓|关系/ },
  { cat: 'tone', re: /说话|语气|口吻|风格|表达|腔调|铁律|去.?ai|人味|回复/ },
  { cat: 'taboo', re: /黑名单|禁区|雷点|禁忌|不要|不接|避免|拒绝|禁用/ },
];

/** 一行是不是小标题（# 标题 / **粗体** / 【方括号】）。 */
function headingOf(line) {
  const t = line.trim();
  let m = /^#{1,6}\s*(.+?)\s*#*$/.exec(t);
  if (m) return m[1].trim();
  m = /^\*\*(.+?)\*\*\s*[:：]?$/.exec(t);
  if (m) return m[1].trim();
  m = /^【(.+?)】\s*[:：]?$/.exec(t);
  if (m) return m[1].trim();
  return '';
}

/** 去掉列表符号、引用符、行内粗体/代码标记。 */
function cleanLine(line) {
  return String(line ?? '')
    .replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function categoryOf(title) {
  for (const rule of TITLE_RULES) if (rule.re.test(title)) return rule.cat;
  return '';
}

/** 角色卡指纹（前 12 位），用来判断内核是不是按旧卡生成的。 */
export function roleCardHash(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex').slice(0, 12);
}

/**
 * 从角色卡正文抽骨架。
 * @param {string} roleContent roles/<角色>.md 全文
 * @param {{roleName?:string, perCat?:number, lineMax?:number}} opts
 * @returns {{body:string, sections:Record<string,string[]>, missing:string[], warnings:string[]}}
 */
export function extractCoreSections(roleContent, { perCat = 2, lineMax = 160 } = {}) {
  const text = String(roleContent ?? '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  const sections = { identity: [], address: [], tone: [], taboo: [] };
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const title = headingOf(line);
    if (title) {
      current = categoryOf(title);
      continue;
    }
    if (!current) continue;
    if (sections[current].length >= perCat) continue;
    const clean = cleanLine(line);
    if (clean.length < 6) continue; // 太短的多半是标签，不是规则
    const clipped = clean.length > lineMax ? clean.slice(0, lineMax).replace(/[，,、]$/, '') + '…' : clean;
    if (!sections[current].includes(clipped)) sections[current].push(clipped);
  }
  const missing = Object.keys(sections).filter((k) => !sections[k].length);
  return { body: '', sections, missing, warnings: [] };
}

/**
 * 生成内核正文（纯文本，不含 front matter）。
 * @returns {{body:string, sections:Record<string,string[]>, missing:string[], warnings:string[]}}
 */
export function draftCoreBody(roleContent, { maxChars = DRAFT_MAX_CHARS } = {}) {
  const { sections, missing } = extractCoreSections(roleContent);
  // 每条都带类别：单看一行「"首先""其次""最后"」会被模型当成该这么说，
  // 标成「不说：」才是禁区的意思。
  const blocks = [];
  for (const cat of ['identity', 'address', 'tone', 'taboo']) {
    const items = sections[cat];
    if (!items.length) continue;
    const lines = items.map((t) => (cat === 'taboo' ? `- 不说：${t}` : `- ${t}`));
    blocks.push([`【${CAT_LABEL[cat]}】`, ...lines].join('\n'));
  }
  const warnings = [];
  let body = blocks.join('\n').trim();
  if (!body) {
    // 一类都没抽到：退化成角色卡开头几行，别让内核空着。
    const fallback = String(roleContent ?? '')
      .split('\n')
      .map((l) => cleanLine(l))
      .filter((l) => l && !headingOf(l) && l.length >= 8)
      .slice(0, 4)
      .join('\n');
    body = fallback;
    warnings.push('角色卡里没有可识别的小标题（身份/称呼/说话/禁区），已退化为开头几行，建议手动整理');
  }
  if (body.length > maxChars) {
    // 按块截断，避免把最后一条拦腰砍断。
    let kept = '';
    for (const block of blocks) {
      if ((kept + '\n' + block).trim().length > maxChars) break;
      kept = (kept + '\n' + block).trim();
    }
    body = kept || body.slice(0, maxChars).replace(/[，,、；;]$/, '');
    warnings.push(`抽取结果超过 ${maxChars} 字，已按块截断`);
  }
  if (missing.length && missing.length < 4) {
    warnings.push(`角色卡里没找到这几类：${missing.map((k) => CAT_LABEL[k]).join('、')}`);
  }
  return { body, sections, missing, warnings };
}

/** 渲染完整的 persona-core 文件（front matter + 正文）。 */
export function renderCoreFile({ roleName, body, sourceHash = '', now = Date.now() } = {}) {
  const date = new Date(now);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const front = [
    '---',
    `role: ${String(roleName ?? '').trim()}`,
    'version: 1',
    'draft: false',
    `updated: ${day}`,
    'budgetChars: 600',
    'generated: true',
    `sourceHash: ${sourceHash || '-'}`,
    'notes: 由角色卡自动生成；改内核请直接编辑本文件（改了记得把 generated 改成 false）。',
    '---',
    '',
  ];
  return `${front.join('\n')}\n${String(body ?? '').trim()}\n`;
}

/** 一键：角色卡 → 内核文件文本。 */
export function draftCoreFile(roleContent, { roleName, now = Date.now(), maxChars = DRAFT_MAX_CHARS } = {}) {
  const drafted = draftCoreBody(roleContent, { maxChars });
  return {
    text: renderCoreFile({ roleName, body: drafted.body, sourceHash: roleCardHash(roleContent), now }),
    ...drafted,
  };
}
