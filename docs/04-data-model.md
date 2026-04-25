---
title: Data Model
status: stable
last-updated: 2026-04-24
owner: round-9
---

# Data Model

MongoDB. Single database. Every document uses MongoDB's native `ObjectId` as `_id` — no manual integer IDs (the legacy schema did this, we're dropping it). All timestamps are stored as `Date`; Mongoose `{ timestamps: true }` adds `createdAt` + `updatedAt` on every collection.

## Collections overview

| Collection | Purpose | Rough doc count for a 10k-user instance |
|---|---|---|
| `users` | Identity + profile, one doc per account | 10k |
| `posts` | Top-level posts by users | ~500k |
| `comments` | Comments on posts (flat or threaded via `parentId`) | ~2M |
| `likes` | Post / comment likes | ~5M |
| `follows` | Directional follow edges | ~200k |
| `tags` | Unique tag registry + counters | ~20k |
| `notifications` | Per-recipient notification inbox | ~5M |
| `conversations` | DM conversation metadata | ~30k |
| `messages` | DM messages within conversations | ~1M |
| `sessions` | `connect-mongo` session store (managed) | transient |

## Schemas

### `users`

Merges the legacy `User` + `Profile` into one document. Login fields and profile fields co-exist.

```ts
{
  _id: ObjectId,
  username: string,            // lowercase, 3–24 chars, [a-z0-9_]
  usernameDisplay: string,     // original casing, for display
  email: string,               // lowercase, unique
  emailVerified: boolean,      // default false
  passwordHash: string,        // bcrypt, 12 rounds; null if OAuth-only
  authProviders: Array<{
    provider: 'google' | 'local',
    providerId?: string
  }>,

  // Profile
  displayName: string,
  bio: string,                 // ≤ 280 chars
  headline: string,            // ≤ 80 chars, shown on profile card
  avatarUrl: string | null,    // Cloudinary URL
  coverUrl: string | null,
  location: string | null,
  website: string | null,
  birthdate: Date | null,

  // Counts (denormalized, maintained by services)
  followerCount: number,
  followingCount: number,
  postCount: number,

  // Preferences
  preferences: {
    theme: 'system' | 'light' | 'dark',
    language: 'en' | 'zh',
    emailNotifications: boolean,
    pushNotifications: boolean
  },

  // Moderation / lifecycle
  status: 'active' | 'suspended' | 'deleted',
  deletedAt: Date | null,
  lastSeenAt: Date,

  createdAt: Date,
  updatedAt: Date
}
```

**Indexes**
- `{ username: 1 }` unique
- `{ email: 1 }` unique
- `{ 'authProviders.provider': 1, 'authProviders.providerId': 1 }` sparse
- `{ status: 1, lastSeenAt: -1 }` for active-user queries

### `posts`

```ts
{
  _id: ObjectId,
  authorId: ObjectId,          // ref: users
  text: string,                // ≤ 5000 chars, Markdown permitted
  images: Array<{
    url: string,
    width: number,
    height: number,
    blurhash?: string
  }>,
  tagIds: ObjectId[],          // ref: tags — resolved at write time
  mentionIds: ObjectId[],      // ref: users — resolved at write time
  visibility: 'public' | 'followers' | 'private',

  echoOf: ObjectId | null,      // ref: posts — always points at the root (no chain echoes)

  // Counts (denormalized, maintained by services via $inc)
  likeCount: number,
  commentCount: number,
  repostCount: number,          // incremented when another post echoes this one

  // Feed ranking — HackerNews gravity score (Round 9)
  // score = (likes + comments×2 + echos×3 + 1) / (age_hours + 2)^1.5
  // Recomputed fire-and-forget after every like / comment / echo event.
  feedScore: number,

  // Moderation / lifecycle
  status: 'active' | 'hidden' | 'deleted',
  editedAt: Date | null,
  deletedAt: Date | null,

  createdAt: Date,
  updatedAt: Date
}
```

**Indexes**
- `{ authorId: 1, createdAt: -1 }` — user profile page (chronological)
- `{ status: 1, createdAt: -1 }` — chronological fallback queries
- `{ status: 1, visibility: 1, feedScore: -1 }` — global / following ranked feed
- `{ tagIds: 1, feedScore: -1 }` — tag feed ranked
- `{ tagIds: 1, createdAt: -1 }` — tag feed chronological fallback
- `{ mentionIds: 1, createdAt: -1 }` — "posts that mention me"
- Text index on `text` for naive search (Round 7+)

### `comments`

Flat with optional `parentId` — supports threaded display without recursive storage.

```ts
{
  _id: ObjectId,
  postId: ObjectId,            // ref: posts
  authorId: ObjectId,
  parentId: ObjectId | null,   // ref: comments (self) for replies
  text: string,                // ≤ 2000 chars
  mentionIds: ObjectId[],

  likeCount: number,

  status: 'active' | 'hidden' | 'deleted',
  editedAt: Date | null,
  deletedAt: Date | null,

  createdAt: Date,
  updatedAt: Date
}
```

**Indexes**
- `{ postId: 1, createdAt: 1 }` — render thread oldest-first
- `{ authorId: 1, createdAt: -1 }` — user's comment history
- `{ parentId: 1 }` — reply lookup

### `likes`

Polymorphic: targets a post or a comment. Single collection simpler than two.

```ts
{
  _id: ObjectId,
  userId: ObjectId,
  targetType: 'post' | 'comment',
  targetId: ObjectId,
  createdAt: Date
}
```

**Indexes**
- `{ userId: 1, targetType: 1, targetId: 1 }` unique — prevents duplicate likes
- `{ targetType: 1, targetId: 1, createdAt: -1 }` — listing likers of a target

### `follows`

Directional edges. "A follows B" is one doc with `followerId=A, followingId=B`.

```ts
{
  _id: ObjectId,
  followerId: ObjectId,
  followingId: ObjectId,
  createdAt: Date
}
```

**Indexes**
- `{ followerId: 1, followingId: 1 }` unique
- `{ followingId: 1, createdAt: -1 }` — "who follows me"
- `{ followerId: 1, createdAt: -1 }` — "who I follow"

### `tags`

Populated on post save. Case-insensitive, stored lowercase.

```ts
{
  _id: ObjectId,
  slug: string,                // lowercase, URL-safe
  display: string,             // original casing of first use
  postCount: number,
  lastUsedAt: Date,
  createdAt: Date
}
```

**Indexes**
- `{ slug: 1 }` unique
- `{ postCount: -1 }` — trending tags page
- `{ lastUsedAt: -1 }` — recently used

### `notifications`

Per-recipient inbox. Generated by services when events happen.

```ts
{
  _id: ObjectId,
  recipientId: ObjectId,
  actorId: ObjectId,           // who caused it
  type: 'like' | 'comment' | 'reply' | 'follow' | 'mention' | 'message',

  // Context — only the relevant pointer is set
  postId: ObjectId | null,
  commentId: ObjectId | null,
  messageId: ObjectId | null,

  read: boolean,
  readAt: Date | null,
  createdAt: Date
}
```

**Indexes**
- `{ recipientId: 1, createdAt: -1 }` — inbox view
- `{ recipientId: 1, read: 1 }` — unread count
- TTL index `{ createdAt: 1 }` with 90-day expiry (configurable; spec in Round 6)

**Dedup rule:** Within a 24h window, collapse same `(recipient, actor, type, target)` into one updated doc instead of inserting. Prevents "X liked your post" × 8 spam after edits.

### `conversations`

A conversation is between 2+ users. v1 is 2-person only; schema supports N.

```ts
{
  _id: ObjectId,
  participantIds: ObjectId[],  // sorted, unique
  participantKey: string,      // sha256 of sorted participantIds — deterministic lookup
  lastMessageId: ObjectId | null,
  lastMessageAt: Date,

  // Per-participant state
  unreadBy: ObjectId[],        // participants who have unread messages

  createdAt: Date,
  updatedAt: Date
}
```

**Indexes**
- `{ participantKey: 1 }` unique — "find conversation between these users"
- `{ participantIds: 1, lastMessageAt: -1 }` — list a user's conversations

### `messages`

```ts
{
  _id: ObjectId,
  conversationId: ObjectId,
  senderId: ObjectId,
  text: string,                // ≤ 4000 chars
  readBy: ObjectId[],          // excluding sender
  deletedFor: ObjectId[],      // soft-delete per participant
  createdAt: Date
}
```

**Indexes**
- `{ conversationId: 1, createdAt: -1 }` — paginated thread

## Relationships (ER summary)

```
users ──< posts ──< comments
  │        │        │
  │        │        ├──< likes (targetType='comment')
  │        ├──< likes (targetType='post')
  │        └──< tags (many-to-many via tagIds)
  │
  ├──< follows (self-referential)
  ├──< notifications (recipientId)
  ├──< conversations (participantIds many-to-many)
  │        └──< messages
  └──< sessions (managed by connect-mongo)
```

## Denormalized counters — integrity rules

We store `likeCount`, `commentCount`, `followerCount`, etc. directly on the parent document to avoid aggregation queries on the hot path. Rules:

1. **Always update via service methods**, never raw `findOneAndUpdate` from a controller.
2. **Counter updates use `$inc`**, never read-modify-write.
3. A **nightly job** (`scripts/reconcile-counters.ts`, Round 7+) recomputes from source of truth and corrects drift.
4. Losing a few counts during an outage is acceptable; never block a user action to guarantee a counter.

## Soft delete policy

- `status: 'deleted'` + `deletedAt` keeps rows for 30 days; a job purges after.
- Reads MUST filter `status: 'active'` by default. Services expose `includeDeleted` as an opt-in for moderation tools.
- On user `deleted`: keep posts/comments but display `[deleted]` author, avatar generic. Full deletion is a separate "erase me" flow (GDPR-style) that overwrites content.

## Local → cloud parity

Exactly **one** env var differs: `MONGODB_URI`. No code branches on deployment target. Both local and Atlas are MongoDB 6.0+, same feature set used. Indexes are created via `mongoose.model.syncIndexes()` on boot.

## Seed data (scripts/seed.ts)

See [`07-setup.md`](./07-setup.md) for the runbook. Creates:

- 15 users with unsplash-sourced avatars
- 50 posts distributed across users and across time (last 30 days)
- ~120 comments including some nested replies
- ~200 likes
- Follow graph: each user follows 3–7 others
- 3 DM conversations with ~10 messages each
- Tags: derived from post text

All images via `https://source.unsplash.com/<seed>/<w>x<h>` for deterministic variety.
