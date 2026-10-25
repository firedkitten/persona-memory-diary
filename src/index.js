// persona-memory-diary —— 角色长期记忆的四层零件。
//
// 全部是纯函数 + 纯文件（JSONL / Markdown），不依赖数据库、不调用模型、
// 不绑定任何具体聊天平台。宿主程序负责「什么时候读、什么时候写」。

export * from './persona-core.js';
export * from './persona-draft.js';
export * from './diary.js';
export * from './facts.js';
export * from './handoff.js';
