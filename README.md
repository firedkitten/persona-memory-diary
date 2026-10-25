# persona-memory-diary

[![Derived from qq-bridge](https://img.shields.io/badge/derived%20from-firedkitten%2Fqq--bridge-4c8eda)](https://github.com/firedkitten/qq-bridge)

给聊天角色用的长期记忆零件：**人格内核 + 长期事实 + 事件日记 + 会话交接单**。

全部是纯文件（JSONL / Markdown / JSON），无数据库、无向量库、不调用模型、不绑定任何聊天平台。压缩会带走对话，带不走这些文件。

```
人格内核  她是谁、怎么说话、不能做什么      → 每轮注入，600 字
长期事实  对方是谁、喜欢什么、雷点在哪      → 每轮注入，300 字 / 6 条
事件日记  发生过什么、答应过什么            → 每轮注入，最近 + 相关，400 字
交接单    上一个会话聊到哪了                → 新会话只读一次，700 字
```

## 来源与适用范围

本插件是 [firedkitten/qq-bridge](https://github.com/firedkitten/qq-bridge) 的**内置衍生插件**。上游仓库用 **qq-bridge + SnowLuma** 的方案把 Agent 接入 QQ 聊天，本库的「内核每轮注入 / 事实抽取 / 日记双写 / 交接单」都是在那套接线里跑出来的。

因此有一句要紧的话：**如果你的方案配置与上游不一致**（接入层不同、消息钩子位置不同、会话标识规则不同、是否每轮注入人格不同），不要照搬接线代码，建议把本仓库连同 [docs/INTEGRATION.md](docs/INTEGRATION.md) 交给你的 Agent 审查，按你的架构做自主适配。

本库本身不依赖任何平台 SDK、不 import 上游代码，适配成本主要在三个地方：钩子挂在哪、`conv`（会话标识）怎么取、以及注入预算与上游提示词如何拼。

> 上面链接的上游用的是 QQ + SnowLuma；本库只负责「记忆零件」，不负责收发消息。

## 为什么需要它

长对话角色会被三件事慢慢磨掉：

- **上下文上限**——越聊越截断，最早的人设最先被挤没；
- **多次压缩/摘要**——每压一次，语气、称呼、约定都在损耗，模型的默认腔调一点点回流；
- **换会话/迁移**——会话状态一丢，角色就像失忆重开。

这个库不追求「上下文永不丢」，而是把**不能丢的东西**外置成有固定预算的文件，每次唤醒按预算重新注入。预算固定，聊天再长也不会更贵。

## 特性

- **按角色隔离**：`persona-core/<角色>.md` 与 `state/<角色>/` 一一对应，多角色共存不串记忆；缺内核的角色静默跳过。
- **按会话窗口隔离**：每条记录带 `conv`（会话标识），注入时只取「本窗口 + 通用」，A 窗口的事不会漏到 B 窗口。
- **内核可回滚**：`draft: true` 一行停用；`personaHash` 每轮日志可查；`sourceHash` 检测角色卡变更后是否该重新生成。
- **内核半自动生成**：从角色卡按小标题摘录「身份 / 称呼 / 说话 / 禁区」，只摘录不编造；覆盖前自动备份旧版。
- **零成本记录**：事实用句式规则从对方消息里抽取，日记在角色已有的「记一笔」调用处双写，不额外花 token。
- **纯文本可迁移**：`cat` / `grep` / `rsync` 就能备份和搬机器，导出即一份 JSON 档案。
- **交接单只读一次**：投递成功才标记已读，不重复占预算，也不删除任何数据。

## 快速开始

```bash
npm install persona-memory-diary
```

（也可以直接把 `src/` 拷进项目——没有运行时依赖，Node ≥ 18。）

```js
import fs from 'node:fs';
import {
  loadPersonaCore, readFacts, readDiary, searchFacts, searchDiary,
  buildFactsBlock, buildDiaryBlock,
} from 'persona-memory-diary';

const ROOT = './memory';
const role = '阿橘';
const scope = 'group:42';                       // 任意会话标识，建议 <channel>:<id>
const query = '今天的消息';                     // 当前这轮的话题，用于相关条目召回

// ① 人格内核
const core = loadPersonaCore(fs.readFileSync(`${ROOT}/persona-core/${role}.md`, 'utf8'));

// ② 长期事实 + ③ 事件日记（只取本窗口与通用条目）
const inScope = (e) => !e.conv || e.conv === scope;
const facts = readFacts(ROOT, role).filter(inScope);
const diary = readDiary(ROOT, role).filter(inScope);

// ④ 拼进系统提示
const block =
  core.block +
  buildFactsBlock({ facts, related: searchFacts(facts, query, { limit: 3 }) }).block +
  buildDiaryBlock({ recent: diary.slice(-6), related: searchDiary(diary, query, { limit: 3 }) }).block;
```

内核文件的最小形态：

```markdown
---
role: 阿橘
version: 1
draft: false
budgetChars: 600
---

我是阿橘，夜里看店的橘猫，不是助手也不是客服。
说话：一条消息 2~15 字，只说一件事；口语，不写小标题。
禁区：不说「作为一个 AI」「希望能帮到你」。
```

目录结构：

```
memory/
├─ persona-core/
│  ├─ 阿橘.md                 # 内核
│  ├─ _template.md            # 手写模板
│  └─ .bak/                   # 覆盖前自动备份
├─ state/阿橘/
│  ├─ diary.jsonl             # 事件日记
│  ├─ facts.jsonl             # 长期事实
│  └─ handoff.json            # 最近一张交接单
└─ handoff/阿橘/<时间戳>.md   # 交接单人读版
```

数据长这样，一行一条，可以直接 `tail`：

```json
{"at":1793000000000,"role":"阿橘","conv":"group:42","kind":"topic","text":"在聊周末去哪","imp":3}
{"at":1793000000000,"role":"阿橘","text":"对方不吃辣","cat":"dislike","key":"对方不吃辣","source":"auto"}
```

## 配置

所有配置都是调用入参或角色文件里的 front matter，没有全局状态：

| 项 | 默认 | 说明 |
|---|---|---|
| `budgetChars`（内核 front matter） | 600 | 100~2000，越界自动夹紧 |
| `diary.maxInjectChars` | 400 | 日记注入预算 |
| `diary.maxEntries` | 6 | 最近条数 |
| `facts.maxInjectChars` | 300 | 事实注入预算 |
| `facts.maxEntries` | 6 | 最多注入条数 |
| `handoff.remindAfterTurns` | 40 | 到点只提醒，不自动换会话 |
| `handoff.maxInjectChars` | 700 | 交接单注入预算 |

见 [`examples/config.example.json`](examples/config.example.json)。

## 模块

| 模块 | 职责 |
|---|---|
| `src/persona-core.js` | 解析内核 front matter、按预算截断、sha256 前 12 位哈希、`draft` 门禁 |
| `src/persona-draft.js` | 从角色卡抽内核草稿（身份/称呼/说话/禁区），只摘录不编造 |
| `src/facts.js` | 事实抽取（11 类句式）、归一化去重、上限淘汰、注入块 |
| `src/diary.js` | JSONL 落盘、10 分钟去重、1MB 轮转、关键词召回、注入块 |
| `src/handoff.js` | 交接单拼装、Markdown 归档、只读一次的 `usedAt` |

详细设计与取舍见 [`docs/DESIGN.md`](docs/DESIGN.md)，接进自己的机器人见 [`docs/INTEGRATION.md`](docs/INTEGRATION.md)。

## 测试

```bash
npm test
# 或分别运行
node scripts/test-persona-core.mjs    # 内核解析 / 截断 / 哈希 / 多角色隔离
node scripts/test-persona-draft.mjs   # 草稿归类 / 禁区措辞 / 退化 / 截断
node scripts/test-diary.mjs           # 落盘 / 去重 / 轮转 / 检索 / 预算
node scripts/test-facts.mjs           # 句式抽取 / 归一化 / 去重 / 删除 / 预算
node scripts/test-handoff.mjs         # 拼装 / 预算 / 只读一次
```

测试只写系统临时目录，不碰真实数据。

预览工具（需要一份真实数据目录）：

```bash
node scripts/preview-persona-core.mjs --root ./memory 阿橘
node scripts/preview-diary.mjs --root ./memory 阿橘 火锅
```

## 隐私与迁移

- 数据全在本地 `state/` 与 `persona-core/`，库不联网、不上报；
- 导出一份 `{ version, exportedAt, roles: { "<角色>": { facts, diary } } }` 即可换机器，导入按角色合并去重；
- `.gitignore` 默认忽略 `state/`、`handoff/`、`persona-core/*.md`（模板除外）。

## 已知限制

- 事实抽取是规则法：中文常见表达够用，隐含表达和长句会漏；需要更高召回可在宿主侧换模型抽取，`appendFact` 接口不变。
- 检索是关键词（中文二元组）计分，不做向量，近义改写召回弱；几千行规模足够。
- 不做加密，隐私边界靠文件系统权限。
- 不提供自动换会话：阈值到了只提醒，换不换由人决定。

## License

[MIT](LICENSE)
