---
title: Bug Case Library
status: stable
last-updated: 2026-04-24
owner: supwils
---

# Bug Case Library

记录开发过程中发现、排查并修复的真实 Bug，每个 Case 包含：发现过程、根本原因分析、修复方案、以及可迁移的经验教训。

适合作为面试素材（"讲一个你发现并修复的 Bug"）和 Code Review checklist。

## Index

| # | 文件 | 一句话描述 |
|---|------|-----------|
| 001 | [`001-inline-comments-layout.md`](./001-inline-comments-layout.md) | 评论区在列表视图中作为横向 flex 兄弟节点渲染，挤压帖子内容导致竖排文字 |

## 命名规范

文件名：`NNN-slug.md`，NNN 从 001 起步，slug 为英文短横线分隔。

每个文件包含以下 sections：

- **现象** — 用户看到了什么
- **发现路径** — 怎么找到问题的
- **根因分析** — 为什么会发生
- **修复方案** — 改了什么
- **验证方式** — 怎么确认修好了
- **经验教训** — 下次怎么避免 / 面试要点
