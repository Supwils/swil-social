---
title: Bug 001 — 评论区挤压帖子内容导致竖排显示
status: stable
last-updated: 2026-04-24
owner: supwils
tags: [css, flexbox, layout, react]
---

# Bug 001 — 评论区挤压帖子内容导致竖排显示

**严重程度：** 高（影响核心阅读体验）  
**发现日期：** 2026-04-24  
**修复耗时：** 约 1 轮对话

---

## 现象

在 Feed 页面的**列表视图**中，点击任意帖子的评论按钮后：

1. 评论区出现在帖子内容的**右侧**，而非下方
2. 帖子正文被挤压到极窄的宽度，文字变成**每行一个汉字/单词**竖排显示
3. 再次点击评论按钮**无法关闭**评论区（toggle 失效），只能刷新页面

截图特征：帖子卡片变成左窄右宽的两栏，左栏是挤成一列的帖子文字，右栏是评论输入框。

---

## 发现路径

### 用户是如何找到这个 Bug 的

1. 先发现了一个相关但不同的问题：部分帖子文字竖排显示（每行一个字）。最初以为是 CSS 问题或 agent 数据问题。
2. 在排查竖排文字的过程中，实际操作了一下评论功能，**点击评论按钮**时偶然触发了这个布局崩溃。
3. 关键观察：*"同一个帖子，点评论前正常，点评论后竖排"* — 这说明竖排不是数据问题，而是**评论区的出现改变了布局**。
4. 进一步观察：评论区出现在内容右侧，而不是下方 — 这是 flexbox 横向排列的典型表现。
5. 用户描述："如果我点 comment，comment 会出现但会显示在右边，然后会把内容挤到左边……如果再点一次，它就不工作了，不会关闭。"

### 关键诊断思路

> "同一套数据，加了一个操作，布局就坏了" → 问题在于**评论区被插入到了错误的 DOM 位置**，而不是数据或 CSS 本身的问题。

---

## 根因分析

### 组件结构（修复前）

```tsx
// PostCard.tsx — 列表模式 return（错误版本）
<article className={s.card}>   {/* display: flex; flex-direction: row */}
  {frontContent}               {/* = <Link>(avatar)</Link> + <div.body>...</div> */}
  <InlineComments ... />       {/* ← 插在这里，成为 article 的第三个 flex 子节点 */}
</article>
```

`frontContent` 是一个 React Fragment，透明包装，不产生 DOM 节点。展开后 `article` 的直接子节点是：

```
article (display: flex; flex-direction: row)
├── <a>  (avatar link)
├── <div class="body">  (flex: 1, post content)
└── <InlineComments>    (grid 展开组件，display: grid)
```

当评论区展开（`grid-template-rows: 1fr`），它占据了 article 横向 flex 行的一列，与 `.body` 平分或压缩水平空间。`.body` 的 `flex: 1` 被新的兄弟节点的宽度覆盖，无法维持。

### 为什么 toggle 也失效

`InlineComments` 的 CSS 展开动画依赖 `grid-template-rows: 0fr → 1fr`。当它变成横向 flex 子节点，`grid` 容器的高度不再受限于父容器，**0fr 实际上也有内容宽度**，导致关闭状态和打开状态视觉上相同，toggle 看起来"不工作"。

### 为什么只在列表模式出现

紧凑/网格模式（compact）在上一次 PR 中已经用 3D flip 重构，评论区在卡片背面单独渲染，不参与正面的 flex 布局，所以不受影响。列表模式的结构没有同步修改。

---

## 修复方案

**核心思路：把 `InlineComments` 从 `article` 的直接子节点，移进 `.body` div 内部。**

`.body` 是 `display: flex; flex-direction: column`，`InlineComments` 在其中自然垂直排列，不再影响 `article` 的横向宽度。

### 代码变更

**PostCard.tsx** — 拆分 `frontContent` 为 `avatarEl`（头像链接）和 `bodyContent`（正文内容），列表模式单独构建 DOM 结构：

```tsx
// 修复前
<>
  {frontContent}               {/* includes avatar + div.body */}
  <InlineComments ... />       {/* article 的直接子节点 ← 问题根源 */}
</>

// 修复后
<>
  {avatarEl}                   {/* 头像 link */}
  <div className={s.body}>
    {bodyContent}              {/* header + text + images + actions */}
    <InlineComments postId={post.id} open={commentsOpen} indented={false} />
    {/* ↑ 在 .body 内部垂直展开，不影响横向宽度 */}
  </div>
</>
```

**InlineComments.tsx / InlineComments.module.css** — 新增 `indented` prop，将左缩进变为可选，避免在列表模式中出现多余的左侧空白：

```tsx
// 新增 prop
interface Props {
  postId: string;
  open: boolean;
  indented?: boolean;   // 默认 true（列表模式传 false）
}

// CSS：把缩进从 .panel 拆到 .panelIndented
.panelIndented {
  margin-left: calc(40px + var(--space-3));
}
```

---

## 验证方式

1. 打开 `http://localhost:5947/feed`，切换到列表视图
2. 点击任意帖子的评论按钮 → 评论区应在帖子正文**下方**展开，帖子文字保持正常宽度
3. 再次点击评论按钮 → 评论区收起（toggle 正常工作）
4. 切换到网格视图 → 卡片翻转正常，不受影响
5. `npx tsc --noEmit` → 无类型错误

---

## 经验教训

### 1. 竖排文字 ≠ CSS 字体问题

遇到竖排文字第一反应是 `writing-mode` 或 `word-break`，但这里的根因是**容器宽度被挤到极小**，不是文字排列方式本身。诊断时应先检查容器的实际渲染宽度。

### 2. React Fragment 的隐形性（深读）

#### 先理解 Fragment 是什么

`<>...</>` 是 `React.Fragment` 的简写。它的唯一作用是"把多个元素包成一组，但不在 DOM 里加任何节点"。

```tsx
// 你写的 JSX
const frontContent = (
  <>
    <a>头像</a>
    <div class="body">正文</div>
  </>
);

// React 渲染到 DOM 后，Fragment 消失了：
// <a>头像</a>
// <div class="body">正文</div>
// 没有任何包装层
```

#### 这在 flexbox 里意味着什么

Flexbox 的规则：**flex 容器的直接子节点**参与空间分配，不是孙子节点，不是后代节点，是**直接子节点**。

修复前的 JSX：

```tsx
<article>           {/* display: flex */}
  {frontContent}    {/* Fragment — 渲染后消失 */}
  <InlineComments /> {/* 直接跟在 Fragment 后面 */}
</article>
```

Fragment 消失后，`article` 实际看到的直接子节点是：

```
article (flex row)
├── <a>          ← avatar link（来自 frontContent 里）
├── <div.body>   ← 正文容器（来自 frontContent 里）
└── <InlineComments>  ← 评论区（动态出现）
```

**共 3 个 flex 子节点横向排列。**

`<div.body>` 设置了 `flex: 1`，意思是"把剩余空间都给我"。当只有 2 个子节点时（avatar + body），body 占满剩余空间，帖子文字宽度正常。

当 `InlineComments` 出现成为第 3 个子节点，`flex: 1` 的含义变了——"剩余空间"现在是减去 `InlineComments` 宽度之后的空间。`InlineComments` 没有设置固定宽度，浏览器按内容给它分配，结果它和 `.body` 横向平分，`.body` 被压窄到几十像素，汉字每行只能放一个字。

#### 直觉记法

> Fragment 是透明的包装纸。撕掉包装纸，里面的每一个元素都直接暴露给父容器。在 flexbox 里，"直接暴露"意味着"参与横向空间瓜分"。

#### 修复为什么有效

把 `InlineComments` 移进 `.body` 内部后：

```
article (flex row)
├── <a>          ← avatar link
└── <div.body>   ← flex: 1，占满剩余宽度
    ├── 正文内容
    └── <InlineComments>   ← 在 .body 内部，column 方向展开
```

`article` 只有 2 个子节点，`.body` 的宽度不受影响。`InlineComments` 在 `.body` 里垂直展开，不抢横向空间。

### 3. "动作触发的 layout 变化" 是强信号

> 用户：点评论前正常，点评论后变形。

这种「操作 A 触发了布局变化 B」的描述，几乎可以直接定位到：**操作 A 动态插入/显示了某个元素，该元素影响了 B 的布局上下文**。不需要排查数据或 CSS reset。

### 4. 先讨论方案，再动手

用户在最终修复前说：*"let me know your thoughts first then I'll let you correct"*。这避免了 Claude 自作主张改了不对的地方再返工。对于布局类 Bug，先描述「哪里的 DOM 结构有问题，打算怎么改」，确认对齐后再执行，效率更高。

### 5. flex 子节点数量是 layout 的关键变量

在 flexbox 容器中，任何新增的直接子节点都会重新分配空间。如果某个组件"按需出现"（如评论区），必须确认它出现后会在哪个 flex/grid 容器中，以及它的出现是否会影响兄弟节点的尺寸。

---

## 面试参考话术

> "我在开发一个社交平台的帖子卡片时，发现了一个布局 Bug：点击评论按钮后，帖子正文会被挤压成竖排。
>
> 最初以为是 CSS 的 `word-break` 或 `writing-mode` 问题，但我注意到**同一帖子点评论前是正常的**，说明问题是评论区出现触发的，而不是文字本身。
>
> 定位后发现：评论组件 `InlineComments` 被渲染为 `article`（`display: flex`）的直接子节点，和帖子正文容器在同一 flex 行里横向排列，把正文挤到了极窄的宽度。
>
> 修复很简单：把 `InlineComments` 移进正文的 `.body` div 内部，让它在列方向展开，不影响横向宽度分配。顺带修复了 toggle 失效的问题，因为原来的 grid 高度动画在横向 flex 布局里根本不生效。
>
> 这个 Bug 让我意识到：React Fragment 的透明性在 flexbox 里会产生意外的兄弟节点关系，动态插入的组件必须仔细考虑它的 DOM 插入位置和对周围布局的影响。"
