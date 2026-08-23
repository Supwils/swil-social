# Remaining product/security gaps — Design Spec

**Date:** 2026-08-22
**Status:** accepted
**Scope:** Three leftover holes from the 2026-08-22 review that are still in
the tree: upload memory bomb, Explore-for-anonymous completeness, keyboard
activation of post cards. Deploy/migrate of already-written work is operator
work and is listed, not executed here (commit/push is forbidden unless the
user says `commit push`).
**Related:** `docs/12-handoff.md` (2026-08-22 sections), review of echo/
bookmark/socket/cookie (already implemented).

---

## 1. Purpose

Close three user-visible / DoS-shaped leftovers so the uncommitted 2026-08-22
slice is actually complete as a product, not just as a security patch set.

## 2. Invariants

1. Image posts still reject files larger than **5 MB** (existing
   `posts.write.ts` rule). Video may be larger than an image but must not
   accept a 50 MB in-memory buffer.
2. Explore remains an **OpenRoute**. After this spec, none of its data
   fetches 401 for an anonymous visitor.
3. Clicking a post card body still opens `/p/:id`. Keyboard must do the same
   without stealing focus from inner links, buttons, or comments.
4. No new dependencies. No commit.

## 3. Upload cap

**Today.** `posts.routes.ts` multer `fileSize: 50 * 1024 * 1024`. Service then
rejects **images** over 5 MB. A 40 MB image still lands in the heap.

**Change.**

- Export two constants from `server/src/modules/posts/posts.limits.ts`:
  - `POST_UPLOAD_FILE_SIZE = 15 * 1024 * 1024` (multer ceiling; video)
  - `POST_IMAGE_MAX_BYTES = 5 * 1024 * 1024` (write-path image check)
- `posts.routes.ts` uses `POST_UPLOAD_FILE_SIZE`.
- `posts.write.ts` uses `POST_IMAGE_MAX_BYTES` (replace the local `MAX_IMG`).
- Contract docs follow the new ceiling: `docs/03-api-reference.md` and
  `docs/06-security.md` (they previously advertised 50 MB per file).
- Test: import the constants; assert write-path still throws the existing
  5 MB validation message for a 5 MB + 1 image buffer. Do not HTTP-upload a
  15 MB blob in unit tests.

## 4. Explore anonymous path

**Today.** Server routes for `/feed/explore-summary`, `GET /users`,
`GET /users/profile-tags` are already `optionalUser` (this working tree).
Client Explore already calls those three. Remaining risk: any Explore child
that still hits a `requireUser` route.

**Change.** Audit `client/src/routes/explore/**` and `ExplorePostsTab`. If a
child still calls a gated endpoint, either switch it to an optional/public
one or skip the query when `useSession().user` is null. Add a server route
test already present for explore-summary; add a client unit test only if a
component currently 401s.

If the audit finds no remaining gated calls, the deliverable is a pinned
comment plus a route-stack test that those three GETs do not include
`requireUser`.

## 5. Keyboard PostCard

**Today.** `<article onClick={openPost}>` has no `tabIndex`, no `onKeyDown`.

**Change.** On the article:

- `tabIndex={0}`
- `role="link"`
- `onKeyDown`: Enter or Space (preventDefault on Space) call the same
  navigation as `openPost`, but only when `event.target === event.currentTarget`
  so inner controls keep their keys.

Test in `PostCard.test.tsx`: focus the article, keyDown Enter, assert the
`/p/:id` route rendered. A second test: keyDown Enter on the hashtag link
does **not** open the post.

## 6. Out of scope (operator, not this spec)

- `git commit` / `git push`
- Neon `0003_per_user_snapshot_hash` against production
- Forcing the 48h opportunistic round
- Prompt injection (separate spec)

## 7. Acceptance

- `npm --prefix server run test` covers the new upload-constant and 5 MB
  image rejection.
- `npm --prefix client run test:run -- src/features/posts/PostCard.test.tsx`
  covers Enter on the card vs Enter on a tag.
- `npm --prefix server run lint` and client lint/typecheck clean.
