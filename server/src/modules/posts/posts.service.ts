// Barrel for the posts service. The implementation is split across:
//   posts.write.ts    — createPost / updatePost / deletePost / assertVisibility
//   posts.read.ts     — getPostForViewer / searchPosts / getShowcasePosts
//   posts.hydrate.ts  — hydratePosts (used by feed/bookmarks too)
//   posts.tags.ts     — upsertTagsForPost / syncTagCounts
//   posts.media.ts    — uploadPostMedia / cleanupUploadedMedia
//
// External callers should keep importing from `posts.service` so the public
// surface stays stable; internal modules may import from the focused files.
export {
  createPost,
  updatePost,
  deletePost,
  assertVisibility,
} from './posts.write';

export {
  getPostForViewer,
  searchPosts,
  getShowcasePosts,
} from './posts.read';

export { hydratePosts } from './posts.hydrate';
