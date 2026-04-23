---
title: API 端点速查
---

# API 端点速查

所有端点前缀：`http://localhost:8888/api/v1`

需要认证的端点用 🔒 标记（需携带 session cookie）。

---

## 认证 `/auth`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | 登录 |
| POST | `/auth/logout` | 登出 🔒 |
| GET | `/auth/me` | 当前登录用户 🔒 |
| POST | `/auth/register` | 注册新账号 |

---

## 信息流 `/feed`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/feed` | 关注的人的帖子 🔒 |
| GET | `/feed/global` | 全站帖子 |
| GET | `/feed/tag/:slug` | 某个 tag 的帖子 |

**分页参数：** `?page=1&limit=20`

---

## 帖子 `/posts`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/posts` | 发帖 🔒 |
| GET | `/posts/:id` | 查看单篇帖子 |
| PATCH | `/posts/:id` | 编辑帖子 🔒（仅作者）|
| DELETE | `/posts/:id` | 删除帖子 🔒（仅作者）|

发帖请求体：
```json
{
  "body": "帖子内容，支持 Markdown，可以用 #tag 和 @username",
  "image": "https://图片URL（可选）"
}
```

---

## 评论 `/comments`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/posts/:id/comments` | 获取某帖子的评论 |
| POST | `/posts/:id/comments` | 发评论 🔒 |
| PATCH | `/comments/:id` | 编辑评论 🔒 |
| DELETE | `/comments/:id` | 删除评论 🔒 |

评论请求体：
```json
{ "body": "评论内容" }
```

---

## 点赞 `/likes`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/posts/:id/like` | 点赞 🔒 |
| DELETE | `/posts/:id/like` | 取消点赞 🔒 |

---

## 关注 `/follows`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/users/:id/follow` | 关注用户 🔒 |
| DELETE | `/users/:id/follow` | 取消关注 🔒 |
| GET | `/users/:id/followers` | 某用户的粉丝列表 |
| GET | `/users/:id/following` | 某用户的关注列表 |

---

## 用户 `/users`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users/:username` | 查看用户主页 |
| PATCH | `/users/me` | 更新自己的资料 🔒 |
| GET | `/users?search=关键词` | 搜索用户 |

更新资料请求体（字段都是可选的）：
```json
{
  "displayName": "新显示名",
  "headline": "个人简介",
  "email": "new@email.com"
}
```

---

## 私信 `/messages`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/messages` | 所有会话列表 🔒 |
| GET | `/messages/:conversationId` | 某个会话的消息 🔒 |
| POST | `/messages/:userId` | 给某用户发私信 🔒 |

发私信请求体：
```json
{ "body": "私信内容" }
```

---

## 通知 `/notifications`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/notifications` | 获取通知列表 🔒 |
| POST | `/notifications/read-all` | 全部标记已读 🔒 |

---

## 常见响应格式

**成功：**
```json
{ "data": { ... }, "meta": { "page": 1, "total": 42 } }
```

**错误：**
```json
{ "message": "错误描述", "fields": { "email": "已被使用" } }
```

**常见状态码：**

| 状态码 | 含义 |
|---|---|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数有误 |
| 401 | 未登录 |
| 403 | 无权限 |
| 404 | 资源不存在 |
| 429 | 请求过于频繁 |
