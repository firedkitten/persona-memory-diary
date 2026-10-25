# 接入指南

这个库只提供零件：解析、拼装、落盘、检索。**什么时候读、什么时候写由宿主决定**。下面按一个典型聊天机器人的生命周期给出接线点，代码是示意，变量名可自行替换。

## 目录约定

```js
const MEMORY_ROOT = path.join(APP_ROOT, 'memory'); // 自己定，建议独立于代码目录
```

库内部只认 `rootDir`，不关心它叫什么。目录结构：

```
memory/
  persona-core/<角色>.md        # 内核，人工/半自动维护
  persona-core/.bak/            # 覆盖前的自动备份
  state/<角色>/diary.jsonl
  state/<角色>/facts.jsonl
  state/<角色>/handoff.json
  handoff/<角色>/<时间戳>.md    # 交接单归档（人读版）
```

## 1. 唤醒时注入

每次真正要用模型之前拼一次，拼完塞进系统提示或消息前缀。顺序固定：

```js
import {
  loadPersonaCore, readFacts, searchFacts, buildFactsBlock,
  readDiary, searchDiary, buildDiaryBlock,
  readHandoff, handoffBlock, isHandoffPending,
} from 'persona-memory-diary';

function buildMemoryBlock({ role, scope, query, pendingHandoff }) {
  // ① 人格内核
  const core = loadPersonaCore(fs.readFileSync(corePath(role), 'utf8'));
  const coreLine = core.block; // draft:true 时是空串

  // ② 长期事实（本窗口 + 通用）
  const facts = readFacts(MEMORY_ROOT, role).filter((e) => inScope(e, scope));
  const factsLine = buildFactsBlock({ facts, related: searchFacts(facts, query, { limit: 3 }) }).block;

  // ③ 事件日记
  const diary = readDiary(MEMORY_ROOT, role).filter((e) => inScope(e, scope));
  const recent = diary.slice(-6);
  const diaryLine = buildDiaryBlock({ recent, related: searchDiary(diary, query, { limit: 3 }) }).block;

  // ④ 交接单（只有未读且属于本窗口时才拼）
  const handoff = pendingHandoff ? handoffBlock(readHandoff(MEMORY_ROOT, role)).block : '';

  return handoff + coreLine + factsLine + diaryLine;
}

const inScope = (entry, scope) => !entry.conv || entry.conv === scope;
```

三块各自的预算由库内默认值控制（内核 600 字、事实 300、日记 400、交接单 700），也可以在调用时用 `budgetChars` 覆盖。

## 2. 消息进线时：事实抽取

只处理**对方发来的**文字，不要处理模型自己说的话，否则角色会给自己编设定：

```js
import { extractFacts, appendFact } from 'persona-memory-diary';

for (const fact of extractFacts(incomingText, { max: 3 })) {
  appendFact(MEMORY_ROOT, {
    role,
    text: fact.text,
    cat: fact.cat,       // identity | dislike | preference | relation | plan
    conv: scope,         // private:123 / group:456 / 自定义
    source: 'auto',
  });
}
```

`appendFact` 自带归一化去重（`factKey`）和 200 条上限，重复写入不会膨胀。

## 3. 角色主动记录：日记双写

如果角色有「记一笔」之类的工具（话题、念头、印象），在同一处顺手写日记，不额外消耗 token：

```js
import { appendDiary } from 'persona-memory-diary';

appendDiary(MEMORY_ROOT, {
  role,
  conv: scope,
  kind: 'topic',        // topic | thought | impression | event | handoff
  text: String(toolArgs.content).slice(0, 200),
  imp: Number(toolArgs.importance ?? 3),
});
```

同窗口同内容 10 分钟内只记一条；文件超过 1MB 自动只留最新 3000 行。

## 4. 角色卡变更：内核草稿与过期

新建角色时自动出一份内核草稿，避免「有角色卡但没内核」：

```js
import { draftCoreFile, roleCardHash } from 'persona-memory-diary';

const card = fs.readFileSync(roleCardPath, 'utf8');
const { text, warnings } = draftCoreFile(card, { roleName: role });
fs.writeFileSync(corePath(role), text);   // 内容只从角色卡摘录，不编造
```

判断内核是否过期：内核 front matter 里存了生成时的 `sourceHash`，与 `roleCardHash(card)` 比对即可。过期只是提示，不阻断注入。

覆盖前建议先备份到 `persona-core/.bak/<角色>-<时间戳>.md`——人改过的内核不应该被静默刷掉。

## 5. 交接单

换会话前生成一张，新会话第一次唤醒读一次：

```js
import { buildHandoff, writeHandoff, markHandoffUsed, isHandoffPending } from 'persona-memory-diary';

// 生成
const data = buildHandoff({
  role, scope,
  facts, diary,                          // 本窗口的条目
  memory: { topics, thoughts },          // 宿主自己的「在聊什么」，可选
  stats: { turns: wakeCount, startedAt },
});
const { file, markdown } = writeHandoff(MEMORY_ROOT, data);

// 注入后、确认投递成功再标记已读
markHandoffUsed(MEMORY_ROOT, role);
```

`isHandoffPending(data, scope)` 判断该不该注入：同窗口、`usedAt === 0`。

**不要自动换会话。** 到阈值时只提醒（发消息/写日志/控制台标红），换不换由人点。

## 6. 面板与导入导出（可选）

如果宿主有管理后台，这几个操作够了：

| 操作 | 库函数 |
|---|---|
| 列出某角色的事实/日记 | `readFacts` / `readDiary` |
| 手动补一条 | `appendFact` / `appendDiary` |
| 删除（带 `at` 精确定位） | `removeFact` / `removeDiary` |
| 导出 | 直接读文件或按 `{ version, exportedAt, roles }` 组装 |
| 导入 | 逐条 `appendFact` / `appendDiary`（自带去重） |

导入按角色合并、自动去重，不依赖源机器的路径。读取建议用 `mtime + size` 做缓存，写完即生效，不需要重启。

## 7. 权限边界

记忆的写入口只开给「控制台/宿主管理员」。如果宿主同时暴露了 AI 可调用的接口，务必让 AI 的 token 在记忆写接口上返回 403——**角色不该能改自己的记忆**，否则一次提示注入就能把它的人设改掉。
