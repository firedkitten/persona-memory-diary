// 人格内核（P1）：把「压缩后绝不能丢的那一小段人设」单独存成 Markdown，每轮注入。
//
// 为什么需要它：
//   完整角色卡（roles/<角色>.md）只在首唤醒时由模型调 qq_get_prompt 拉一次，之后就活在
//   DSH 会话上下文里。上下文一压缩，最先被挤掉的往往就是这份"一次性内容"，模型只剩下
//   工具协议和几句聊天记录，于是口癖、态度、边界全漂——这就是性格偏差的来源。
//   内核 ≤600 字、每轮都发，等于给模型一个压缩也删不掉的锚。
//
// 设计约束：
//   1. 正文只由人改（AI 只能给建议），所以这里没有任何写接口；
//   2. 文件带 `draft: true` 时不注入，便于先写草稿、审核通过再启用；
//   3. 纯函数 + 显式入参（文本），不读磁盘、不碰 env，方便单测。
import { createHash } from 'node:crypto';

/** 默认注入上限（字符）。超出按句号软截断，并在块里标注。 */
export const PERSONA_CORE_MAX_CHARS = 600;

/** 每个角色可在 front matter 用 `budgetChars` 自定预算；这是允许的区间，防手滑写 9999。 */
export const PERSONA_CORE_MIN_CHARS = 100;
export const PERSONA_CORE_HARD_MAX_CHARS = 2000;

/** 注入块的标题行：短、醒目，且明确"始终遵守"，避免模型当成可选参考。 */
export const CORE_HEADER = '【人格内核 · 始终遵守】';

/**
 * 拆分 front matter 与正文。只认最简单的 `key: value` 行（够用，不引 YAML 依赖）。
 * @returns {{ front: Record<string, string>, body: string }}
 */
export function parsePersonaCore(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source);
  if (!match) return { front: {}, body: source.trim() };
  const front = {};
  for (const line of match[1].split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    front[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { front, body: match[2].trim() };
}

/** 是否处于草稿状态（`draft: true` 或省略都算未启用？不——省略视为已启用，显式 true 才算草稿）。 */
export function isDraft(front) {
  const v = String(front?.draft ?? '').toLowerCase();
  return v === 'true' || v === 'yes' || v === '1';
}

/** 内核正文指纹：只取前 12 位，够区分"这轮的人设是不是同一份"。 */
export function personaHash(body) {
  return createHash('sha256').update(String(body ?? ''), 'utf8').digest('hex').slice(0, 12);
}

/**
 * 按预算裁切：优先在最后一个句末标点处断开，实在找不到就硬切。
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateCore(body, budget = PERSONA_CORE_MAX_CHARS) {
  const text = String(body ?? '').trim();
  const max = Math.max(50, Number(budget) || PERSONA_CORE_MAX_CHARS);
  if (text.length <= max) return { text, truncated: false };
  const slice = text.slice(0, max);
  const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('；'), slice.lastIndexOf('\n'));
  const kept = (cut > max * 0.6 ? slice.slice(0, cut + 1) : slice).trim();
  return { text: kept, truncated: true };
}

/**
 * 组装要插进唤醒 prompt 的整块文本（含标题与空行）。
 * @returns {{ block: string, chars: number, truncated: boolean }}
 */
export function buildPersonaCoreBlock(body, budget = PERSONA_CORE_MAX_CHARS) {
  const { text, truncated } = truncateCore(body, budget);
  if (!text) return { block: '', chars: 0, truncated: false };
  const note = truncated ? '\n（内核超出预算，已截断；完整内容仍可调 qq_get_prompt 查看）' : '';
  return { block: `${CORE_HEADER}\n${text}${note}\n\n`, chars: text.length, truncated };
}

/**
 * 从 front matter 取该角色自己的预算（多个人格共用一套代码，但预算不必统一）。
 * 没写/写坏 → 回落到 600；越界 → 夹到 100~2000，避免手滑写 9999 把上下文吃光。
 */
export function coreBudgetFrom(front, fallback = PERSONA_CORE_MAX_CHARS) {
  const raw = Number(front?.budgetChars);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(PERSONA_CORE_HARD_MAX_CHARS, Math.max(PERSONA_CORE_MIN_CHARS, Math.round(raw)));
}

/**
 * 从文件文本解析出「可直接注入」的内核。
 * 预算优先级：显式入参 > 文件 front matter 的 budgetChars > 600。
 * @returns {{ role: string, version: string, draft: boolean, body: string, chars: number, hash: string, block: string, truncated: boolean, budget: number }}
 */
export function loadPersonaCore(text, { budget } = {}) {
  const { front, body } = parsePersonaCore(text);
  const draft = isDraft(front);
  const limit = Number.isFinite(Number(budget)) && Number(budget) > 0 ? Number(budget) : coreBudgetFrom(front);
  const built = draft ? { block: '', chars: body.length, truncated: false } : buildPersonaCoreBlock(body, limit);
  return {
    role: front.role ?? '',
    version: front.version ?? '',
    draft,
    body,
    chars: built.chars,
    hash: personaHash(body),
    block: built.block,
    truncated: built.truncated,
    budget: limit,
  };
}
