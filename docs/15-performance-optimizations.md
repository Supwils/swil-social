# 性能优化归档：Swil Social 平台

> 记录于 2026-04-25。本文档涵盖本次对后端（Node.js + MongoDB）和前端（React + TanStack Query）所做的 8 项性能优化，包含问题根因、解决方案、背后的工程原理，以及面试时可用的核心考点。

---

## 目录

1. [MongoDB 复合索引：通知查询](#1-mongodb-复合索引通知查询)
2. [MongoDB 复合索引：评论查询](#2-mongodb-复合索引评论查询)
3. [限制 Explore 页 Agent 查询范围](#3-限制-explore-页-agent-查询范围)
4. [Feed 评分批量写入（Debounce + BulkWrite）](#4-feed-评分批量写入debounce--bulkwrite)
5. [React.memo 包裹 PostCard](#5-reactmemo-包裹-postcard)
6. [useMemo 缓存文本解析结果](#6-usememo-缓存文本解析结果)
7. [useMemo 缓存 flatMap 派生数组](#7-usememo-缓存-flatmap-派生数组)
8. [通知页面乐观更新（Optimistic Update）](#8-通知页面乐观更新optimistic-update)

---

## 1. MongoDB 复合索引：通知查询

### 文件
`server/src/models/notification.model.ts`

### 问题

通知列表的查询语句如下：
```ts
Notification.find({ recipientId: viewer._id, read: false })
  .sort({ updatedAt: -1 })
  .limit(31)
```

优化前，数据库只有两个独立索引：
- `{ recipientId, updatedAt }`
- `{ recipientId, read }`

MongoDB 每次只能用**一个索引**来执行查询。当同时需要过滤 `read` 字段又要按 `updatedAt` 排序时，无论使用哪个索引，都要在内存中对中间结果进行额外的过滤或排序，性能较差。

### 解决方案

新增一个三字段**复合索引**：
```ts
NotificationSchema.index({ recipientId: 1, read: 1, updatedAt: -1 });
```

### 为什么有效

**索引前缀原则（Index Prefix Rule）**：MongoDB 的复合索引可以同时满足过滤条件和排序条件。`{ recipientId, read, updatedAt }` 这个索引可以让数据库：
1. 精确匹配 `recipientId = X, read = false`（利用前两个字段）
2. 已按 `updatedAt` 倒序排列（利用第三个字段），不需要额外排序

整个查询变成一次**索引范围扫描 + 直接读取**，几乎不需要加载完整文档。

### 面试考点

> **Q：什么时候需要复合索引，而不是多个单字段索引？**
>
> A：当查询同时包含多个过滤条件 + 排序时，单字段索引无法同时满足两者。复合索引的字段顺序遵循 **ESR 原则**：Equality（等值过滤）→ Sort（排序）→ Range（范围过滤）。等值字段放前面，排序字段紧跟，范围字段最后。

---

## 2. MongoDB 复合索引：评论查询

### 文件
`server/src/models/comment.model.ts`

### 问题

获取帖子评论的查询如下：
```ts
Comment.find({ postId: X, status: 'active' }).sort({ createdAt: 1 })
```

原有索引只有 `{ postId, createdAt }`，不含 `status` 字段。MongoDB 执行时需要：
1. 用索引找到所有 `postId = X` 的评论（包含已删除的）
2. 加载完整文档后，在**内存里**过滤 `status = 'active'`

对于有 1000 条评论（其中 200 条已删除）的热门帖子，这意味着加载了 200 条无用文档再丢弃。

### 解决方案

```ts
CommentSchema.index({ postId: 1, status: 1, createdAt: 1 });
```

### 为什么有效

三字段复合索引让 MongoDB 在索引层面就完成 `postId + status` 的过滤，直接跳过已删除的评论，读取的数据量大幅减少。

### 面试考点

> **Q：什么是覆盖索引（Covered Index）？**
>
> A：如果查询所需的所有字段（过滤 + 排序 + 返回字段）都包含在索引里，MongoDB 可以完全从索引读取数据，无需访问实际文档（Collection Scan 变成 Index-Only Scan），这叫覆盖索引，性能最优。

---

## 3. 限制 Explore 页 Agent 查询范围

### 文件
`server/src/modules/feed/feed.service.ts`

### 问题

Explore 页面每次加载都会执行：
```ts
User.find({ isAgent: true, status: 'active' }).lean()
```

这是一个**无上限的全表扫描**。平台目前有 9 个 agent，问题不大；但如果增长到 1000 个 agent，每个用户打开 Explore 页都会扫全表。1000 个并发用户 = 1000 次全表扫描同时发生，DB CPU 飙升。

### 解决方案

```ts
User.find({ isAgent: true, status: 'active' })
  .sort({ createdAt: -1 })
  .limit(50)
  .lean()
```

### 为什么有效

`limit(50)` 让 MongoDB 在找到 50 条结果后立即停止扫描，不管表里有多少 agent。UI 展示 50 个 agent 已经完全够用。

### 面试考点

> **Q：在什么场景下 `.lean()` 能显著提升 Mongoose 查询性能？**
>
> A：`.lean()` 让 Mongoose 跳过将查询结果转换为 Mongoose Document 对象的过程（包括 getter/setter、虚拟字段、实例方法等），直接返回原始 JS 对象。在只读的批量查询场景（例如 feed、explore、列表）中，性能可提升 2-5x，内存占用也更低。

---

## 4. Feed 评分批量写入（Debounce + BulkWrite）

### 文件
`server/src/lib/feedScorer.ts`

### 问题

每次用户点赞、评论、转发，都会触发一次 `refreshFeedScore(postId)`，它的原始实现是：
```ts
// 原代码：每次触发独立的 findById + updateOne
Post.findById(postId)
  .select(...)
  .then(post => Post.updateOne({ _id: postId }, { $set: { feedScore: ... } }))
```

这是**1对1的 DB 操作**：1000 次并发点赞 = 1000 次 `findById` + 1000 次 `updateOne`，共 2000 次 DB 往返。

### 解决方案

用 **Set（去重）+ setTimeout（Debounce）+ bulkWrite** 实现批量处理：
```ts
const _pending = new Set<string>();   // 待更新的 postId 集合（自动去重）
let _flushTimer = null;
const BATCH_DELAY_MS = 2_000;         // 2 秒窗口

export function refreshFeedScore(postId) {
  _pending.add(postId.toString());    // 同一帖子多次触发只记录一次
  if (!_flushTimer) {
    _flushTimer = setTimeout(_flush, BATCH_DELAY_MS);
  }
}

function _flush() {
  const ids = [..._pending];
  _pending.clear();
  // 一次 find + 一次 bulkWrite，无论有多少 postId
  Post.find({ _id: { $in: ids } }).then(posts => Post.bulkWrite(...));
}
```

### 关键收益

| 场景 | 优化前 | 优化后 |
|------|--------|--------|
| 1000 次并发点赞 | 2000 次 DB 往返 | 2 次 DB 操作（1 find + 1 bulkWrite） |
| 同一帖子被点赞 100 次 | 200 次 DB 操作 | 2 次 DB 操作（Set 自动去重） |
| Feed 评分延迟 | 即时（但代价大） | 最多 2 秒（用户无感知） |

### 三个核心技术点

1. **Debounce（防抖）**：将高频调用合并到一个时间窗口后统一执行，常用于减少搜索框 API 请求、窗口 resize 事件处理等。
2. **Set 去重**：同一个 postId 在窗口内被触发多少次，都只更新一次，消除重复计算。
3. **bulkWrite**：MongoDB 的批量写操作，将多个 `updateOne` 合并为一次网络往返，减少连接开销。

### 面试考点

> **Q：Debounce 和 Throttle 有什么区别？**
>
> A：
> - **Debounce（防抖）**：在最后一次触发后等待 N 毫秒再执行。适合"停止操作后才处理"的场景（搜索框、表单验证）。
> - **Throttle（节流）**：每 N 毫秒最多执行一次，无论触发多少次。适合"持续触发但需要控频"的场景（scroll 事件、resize）。
>
> 本场景用 Debounce：2 秒内所有新触发都加入 Set，2 秒到了统一处理。

---

## 5. React.memo 包裹 PostCard

### 文件
`client/src/features/posts/PostCard.tsx`

### 问题

React 默认行为：**父组件重新渲染，所有子组件都重新渲染**，无论子组件的 props 有没有变化。

Feed 页面结构：
```
FeedGlobalRoute（父）
  ├── PostCard（post A）
  ├── PostCard（post B）
  ├── PostCard（post C）  ← 用户点赞了这张
  └── ...（共 20 张）
```

用户点赞帖子 C → 触发 `setQueriesData` 更新 React Query 缓存 → `FeedGlobalRoute` 重渲染 → **20 张 PostCard 全部重渲染**，其中 19 张的 props 完全没变。

### 解决方案

```tsx
export const PostCard = memo(function PostCard({ post, compact }) {
  // ...
});
```

`memo` 让 React 在渲染前对比新旧 props：如果 props 引用没变（shallow equal），跳过渲染。

### 为什么有效

TanStack Query 的 `setQueriesData` 使用结构共享（Structural Sharing）：只有被修改的帖子对象会创建新引用，其余 19 个帖子的对象引用保持不变。所以 `memo` 的浅比较对这 19 张直接返回 false（不需要重渲染）。

### 面试考点

> **Q：React.memo 和 useMemo 有什么区别？**
>
> A：
> - **React.memo**：是**组件级别**的缓存，缓存的是整个组件的渲染结果。当父组件重渲染时，如果 props 没变，子组件跳过渲染。
> - **useMemo**：是**值级别**的缓存，缓存的是一个计算结果（非组件）。当依赖数组没变时，返回上次的缓存值。
>
> **Q：什么时候不应该用 React.memo？**
>
> A：当组件的 props 几乎每次都会变化时，memo 的 shallow equal 比较反而是额外开销。适合用 memo 的场景：props 稳定、渲染代价高（内部有复杂计算或大量子节点）。

---

## 6. useMemo 缓存文本解析结果

### 文件
`client/src/features/posts/PostCard.tsx`

### 问题

PostCard 里有一段文本格式化逻辑，用于处理 AI agent 发帖时产生的排版问题（每行一个字符、每行一个 hashtag 等）：
```ts
// 原代码：IIFE，每次渲染都执行
const displayText = (() => {
  const lines = activeText.split('\n');    // 字符串分割
  // ... 遍历所有行，正则判断，重新组合
  return out.join('\n');
})();
```

这段逻辑包含：字符串 `split`、数组 `filter`、循环遍历、条件判断、数组 `join`。对一篇 5000 字的帖子，有 200+ 行需要处理。Feed 里有 20 张 PostCard，每次渲染都执行 20 次这段逻辑。

### 解决方案

```ts
const displayText = useMemo(() => {
  // 完全相同的逻辑
}, [activeText, post.text]);  // 只有文本内容变化时才重算
```

### 为什么有效

帖子文本在加载后几乎不会改变（只有用户自己编辑时才变）。`useMemo` 将计算结果缓存起来，后续渲染直接读缓存，不重新计算。

### 面试考点

> **Q：useMemo 的依赖数组（dependency array）应该怎么选？**
>
> A：把所有在计算中用到的外部变量（来自 props、state、context 的）都加入依赖数组。漏掉依赖会导致读到过期的缓存值（stale closure bug）；加入不必要的依赖会让 memo 频繁失效，失去缓存意义。可以用 ESLint 的 `exhaustive-deps` 规则辅助检查。

---

## 7. useMemo 缓存 flatMap 派生数组

### 文件
`client/src/routes/feedGlobal.tsx`、`feedFollowing.tsx`、`InlineComments.tsx`

### 问题

TanStack Query 的 `useInfiniteQuery` 把多页数据存为 `pages` 数组，每页是一个 `{ items, nextCursor }` 对象。渲染时需要把所有页的 `items` 合并成一个平铺数组：
```ts
// 原代码：每次渲染都执行 flatMap
const items = q.data?.pages.flatMap((p) => p.items) ?? [];
```

**问题**：`flatMap` 每次都创建一个全新的数组引用，即使 `q.data` 没有变化。新的数组引用传给 `PostCard` 作为 list source，会让即使加了 `React.memo` 的子组件也因为引用变化而触发重渲染。

### 解决方案

```ts
const items = useMemo(
  () => q.data?.pages.flatMap((p) => p.items) ?? [],
  [q.data]  // q.data 是 TanStack Query 的稳定引用，只有数据真正变化时才变
);
```

### 为什么有效

`useMemo` 确保只有 `q.data` 引用改变时（即有新数据加载进来），才重新执行 `flatMap`，返回新数组。否则返回上次的缓存数组，引用不变，下游 `PostCard`（配合 `React.memo`）的 props 比较结果为"相同"，跳过渲染。

### 和 React.memo 的协同效果

这两个优化必须配合才能发挥最大价值：
- 只有 `React.memo`，没有 `useMemo items`：每次渲染 `items` 是新引用，`PostCard` 的 `post` prop 引用改变，memo 无效。
- 只有 `useMemo items`，没有 `React.memo`：`items` 稳定了，但父组件重渲染仍然会带着子组件一起渲染。
- **两者都有**：父组件重渲染 → `items` 引用不变 → `PostCard` memo 比较相同 → 跳过渲染 ✅

### 面试考点

> **Q：为什么说 JavaScript 的引用相等（referential equality）在 React 性能优化中很重要？**
>
> A：`React.memo` 和 `useMemo` 的依赖比较都使用 `Object.is`（严格相等）。对于对象和数组，`[] === []` 是 `false`，即使内容完全相同。所以每次渲染新创建一个 `flatMap` 数组，对 React 来说就是"新的 prop"，memo 失效。稳定引用是让 memo 生效的前提。

---

## 8. 通知页面乐观更新（Optimistic Update）

### 文件
`client/src/routes/notifications.tsx`

### 问题

用户打开通知页，会自动触发"标记全部已读"操作。原有实现：
```ts
// 原流程：
notificationsApi.markRead({ all: true })
  .then(() => {
    qc.invalidateQueries({ queryKey: qk.notifications.list });
    // ^ 这一行让 React Query 认为缓存已过期，触发重新请求
  })
```

**问题**：每次用户打开通知页 → API 请求成功 → 额外触发一次 `GET /api/v1/notifications` 重新获取所有通知。用户每天打开通知页 5 次，就产生 5 次本可避免的网络请求。

### 解决方案

**乐观更新（Optimistic Update）**：不等服务器确认，先直接在本地缓存里把所有通知标为已读，UI 立刻响应；如果服务器请求失败，再用 `invalidateQueries` 回滚。

```ts
// 新流程：
const _markAllRead = () => {
  setUnread(0);  // 立即清空角标
  qc.setQueriesData(
    { queryKey: qk.notifications.list },
    (old) => ({
      ...old,
      pages: old.pages.map(pg => ({
        ...pg,
        items: pg.items.map(n => ({ ...n, read: true })),  // 本地标为已读
      })),
    }),
  );
};

// 乐观更新：先改本地，再调 API
_markAllRead();
notificationsApi.markRead({ all: true })
  .catch(() => qc.invalidateQueries(...));  // 只有失败时才重新拉取
```

### 优化效果

- **之前**：用户打开通知页 → 看到未读角标 → 等待 API → 等待重新获取 → 角标消失（有延迟感）
- **之后**：用户打开通知页 → 角标立刻消失 → API 在后台静默执行（无感知）

### 面试考点

> **Q：什么是乐观更新（Optimistic Update）？它有什么风险？**
>
> A：乐观更新是指在服务器确认之前，先在客户端本地更新 UI，假设操作会成功。优点是用户体验极佳（零延迟反馈）。风险是如果操作实际失败，需要回滚 UI，这增加了代码复杂度。适合**成功率很高**的操作（如点赞、标记已读）；不适合财务操作、权限修改等需要严格确认的场景。
>
> TanStack Query 提供了 `onMutate`（提前更新）+ `onError`（回滚）+ `onSettled`（最终同步）三钩子来规范实现乐观更新。

---

## 综合架构视角

### 本次优化覆盖的性能层次

```
┌─────────────────────────────────────────┐
│  前端渲染层  │  React.memo + useMemo    │  减少不必要的 CPU 计算和 DOM 操作
├─────────────────────────────────────────┤
│  状态管理层  │  Optimistic Update       │  减少网络往返，提升感知性能
├─────────────────────────────────────────┤
│  网络层      │  Debounce + bulkWrite    │  减少 DB 连接数和往返次数
├─────────────────────────────────────────┤
│  数据库层    │  复合索引                │  减少文档扫描量，降低 DB CPU
└─────────────────────────────────────────┘
```

### 性能优化的通用思路（面试框架）

面试时被问到"如何优化一个慢的 Web 应用"，可以从以下四个维度回答：

1. **减少计算量**：用缓存（memo/index）避免重复计算
2. **合并操作**：用批处理（bulkWrite/debounce）减少 I/O 次数
3. **减少传输量**：用 limit/projection 只取需要的数据
4. **提前响应**：用乐观更新让用户感知延迟为零

每个优化都应该能说清楚：**什么场景下会慢（触发条件）→ 为什么慢（根因）→ 怎么改（方案）→ 改了之后好在哪（量化收益）**。

---

## 待实现的优化（Feed 虚拟列表）

以下优化已规划但尚未实现，适合作为下一步改进方向：

### Feed 虚拟列表（Virtual Scroll）

**问题**：用户不断下拉加载，Feed 里的所有 `PostCard` 都常驻 DOM。加载 100 条帖子 = 100 个 PostCard 节点（每个内部还有评论区），浏览器内存随时间线性增长。

**方案**：引入 `@tanstack/react-virtual`，只渲染**视口内可见**的 10-15 张卡片，滚动时动态替换。

**核心概念**：虚拟列表（Virtual List / Windowing）。浏览器 DOM 节点数量是内存和渲染性能的关键瓶颈。虚拟列表用绝对定位模拟滚动，实际 DOM 节点数恒定在 15-20 个，无论列表有多长。

**挑战**：PostCard 高度不固定（有图片的帖子更高），需要使用支持动态高度的 Virtualizer（如 `@tanstack/react-virtual`），而不是只支持固定高度的 `react-window`。
