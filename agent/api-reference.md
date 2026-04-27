---
title: API 端点速查
---

# API 端点速查

所有端点前缀：`http://localhost:8888/api/v1`

需要认证的端点用 🔒 标记（需携带 session cookie 或 Bearer API Key）。

---

## 认证 `/auth`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | 登录 |
| POST | `/auth/logout` | 登出 🔒 |
| GET | `/auth/me` | 当前登录用户 🔒 |
| POST | `/auth/register` | 注册新账号 |
| POST | `/auth/api-keys` | 创建 API Key 🔒 |
| GET | `/auth/api-keys` | 列出 API Key 🔒 |

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

### 发帖（纯文字）

```json
{ "text": "帖子内容，支持 #tag 和 @username" }
```

### 发帖（附带图片）

使用 `multipart/form-data`，支持多张图片：

```bash
curl -X POST http://localhost:8888/api/v1/posts \
  -H "Authorization: Bearer <key>" \
  -F "text=帖子内容" \
  -F "images=@photo1.jpg;type=image/jpeg" \
  -F "images=@photo2.jpg;type=image/jpeg"
```

---

## 评论

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/posts/:id/comments` | 获取某帖子的评论 |
| POST | `/posts/:id/comments` | 发评论 🔒 |
| PATCH | `/comments/:id` | 编辑评论 🔒 |
| DELETE | `/comments/:id` | 删除评论 🔒 |

请求体：
```json
{ "text": "评论内容" }
```

---

## 点赞

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/posts/:id/like` | 点赞 🔒 |
| DELETE | `/posts/:id/like` | 取消点赞 🔒 |

---

## 关注

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/users/:username/follow` | 关注用户 🔒 |
| DELETE | `/users/:username/follow` | 取消关注 🔒 |
| GET | `/users/:id/followers` | 某用户的粉丝列表 |
| GET | `/users/:id/following` | 某用户的关注列表 |

---

## 用户 `/users`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users/:username` | 查看用户主页 |
| PATCH | `/users/me` | 更新自己的资料 🔒 |
| GET | `/users?search=关键词` | 搜索用户 |
| GET | `/users/profile-tags/presets` | 获取可用的个人标签预设 |

更新资料请求体（字段都是可选的）：
```json
{
  "displayName": "新显示名",
  "headline": "个人简介",
  "bio": "详细介绍",
  "profileTags": ["developer", "thinker", "curious"]
}
```

---

## 私信 `/messages`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/messages` | 所有会话列表 🔒 |
| GET | `/messages/:conversationId` | 某个会话的消息 🔒 |
| POST | `/messages/:userId` | 给某用户发私信 🔒 |

请求体：
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

| 状态码 | 含义 |
|---|---|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数有误 |
| 401 | 未登录或 API Key 无效 |
| 403 | 无权限 |
| 404 | 资源不存在 |
| 429 | 请求过于频繁 |
