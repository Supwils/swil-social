import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { AppError } from '../../lib/errors';
import { Post, type PostDocument } from '../../models/post.model';
import { Tag } from '../../models/tag.model';
import { User, type UserDocument } from '../../models/user.model';
import { Like } from '../../models/like.model';
import { Follow } from '../../models/follow.model';
import * as s3 from '../../config/s3';
import * as notifications from '../notifications/notifications.service';
import { assertVisibility, createPost, updatePost } from './posts.service';

function makeUser(id = new Types.ObjectId()): UserDocument {
  return {
    _id: id,
    id: id.toString(),
    username: 'ada',
    displayName: 'Ada',
    usernameDisplay: 'ada',
    avatarUrl: null,
    headline: '',
    profileTags: [],
    isAgent: false,
  } as UserDocument;
}

function makePost(overrides: Partial<PostDocument> = {}): PostDocument {
  const authorId = new Types.ObjectId();
  return {
    _id: new Types.ObjectId(),
    authorId,
    text: '',
    images: [],
    video: null,
    tagIds: [],
    mentionIds: [],
    visibility: 'public',
    likeCount: 0,
    commentCount: 0,
    status: 'active',
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-04-23T00:00:00.000Z'),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PostDocument;
}

function makeTag(id = new Types.ObjectId(), slug = 'tag') {
  return {
    _id: id,
    slug,
    display: slug,
  };
}

describe('posts.service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a pure-image post without requiring text', async () => {
    const author = makeUser();
    const post = makePost({ authorId: author._id, text: '' });

    vi.spyOn(s3, 'uploadBufferToS3').mockResolvedValue({
      url: 'https://cdn.example.com/post.webp',
      width: 1200,
      height: 900,
    });
    vi.spyOn(Post, 'create').mockResolvedValue(post);
    vi.spyOn(User, 'updateOne').mockResolvedValue({ acknowledged: true } as never);
    vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    const out = await createPost(author, { text: '', visibility: 'public' }, [Buffer.from('img')], null);

    expect(out.post).toBe(post);
    expect(s3.uploadBufferToS3).toHaveBeenCalledTimes(1);
    expect(Post.create).toHaveBeenCalledWith(expect.objectContaining({
      text: '',
      visibility: 'public',
      images: [expect.objectContaining({ url: 'https://cdn.example.com/post.webp' })],
      video: null,
    }));
  });

  it('creates a pure-video post without requiring text', async () => {
    const author = makeUser();
    const post = makePost({ authorId: author._id, text: '' });

    vi.spyOn(s3, 'uploadVideoBufferToS3').mockResolvedValue({
      url: 'https://cdn.example.com/post.mp4',
      width: 1920,
      height: 1080,
    });
    vi.spyOn(Post, 'create').mockResolvedValue(post);
    vi.spyOn(User, 'updateOne').mockResolvedValue({ acknowledged: true } as never);

    const out = await createPost(author, { text: '', visibility: 'public' }, [], Buffer.from('vid'));

    expect(out.post).toBe(post);
    expect(s3.uploadVideoBufferToS3).toHaveBeenCalledTimes(1);
    expect(Post.create).toHaveBeenCalledWith(expect.objectContaining({
      images: [],
      video: expect.objectContaining({ url: 'https://cdn.example.com/post.mp4' }),
    }));
  });

  it('rejects empty posts', async () => {
    await expect(createPost(makeUser(), { text: '', visibility: 'public' }, [], null)).rejects
      .toMatchObject<AppError>({ code: 'VALIDATION_ERROR' });
  });

  it('rolls back uploaded media if post persistence fails', async () => {
    const author = makeUser();

    vi.spyOn(s3, 'uploadBufferToS3').mockResolvedValue({
      url: 'https://cdn.example.com/orphan.webp',
      width: 800,
      height: 600,
    });
    vi.spyOn(Post, 'create').mockRejectedValue(new Error('db down'));
    vi.spyOn(s3, 'deleteFromS3').mockResolvedValue(undefined);

    await expect(
      createPost(author, { text: '', visibility: 'public' }, [Buffer.from('img')], null),
    ).rejects.toThrow('db down');

    expect(s3.deleteFromS3).toHaveBeenCalledWith('https://cdn.example.com/orphan.webp');
  });

  it('reconciles tag counts when editing tags on a post', async () => {
    const author = makeUser();
    const oldTagId = new Types.ObjectId();
    const newTagA = makeTag(new Types.ObjectId(), 'new-a');
    const newTagB = makeTag(new Types.ObjectId(), 'new-b');
    const post = makePost({
      authorId: author._id,
      text: '#old',
      tagIds: [oldTagId],
      mentionIds: [],
    });

    vi.spyOn(Post, 'findById')
      .mockResolvedValueOnce(post)
      .mockResolvedValueOnce(post);
    vi.spyOn(Tag, 'bulkWrite').mockResolvedValue({} as never);
    vi.spyOn(Tag, 'find').mockResolvedValue([newTagA, newTagB] as never);
    const updateMany = vi.spyOn(Tag, 'updateMany').mockResolvedValue({ acknowledged: true } as never);
    vi.spyOn(User, 'findById').mockResolvedValue(author);
    vi.spyOn(Like, 'exists').mockResolvedValue(false as never);

    const out = await updatePost(post._id.toString(), author, {
      text: '#new-a #new-b',
    });

    expect((post.save as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      { _id: { $in: [newTagA._id, newTagB._id] } },
      expect.objectContaining({ $inc: { postCount: 1 } }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      { _id: { $in: [oldTagId] } },
      { $inc: { postCount: -1 } },
    );
    expect(out.post).toBe(post);
  });

  it('hides follower-only posts from non-followers', async () => {
    const viewer = makeUser();
    const authorId = new Types.ObjectId();
    const post = makePost({ authorId, visibility: 'followers' });

    vi.spyOn(Follow, 'exists').mockResolvedValue(false as never);

    await expect(assertVisibility(post, viewer)).rejects.toMatchObject<AppError>({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('allows the author to read their own private posts', async () => {
    const author = makeUser();
    const post = makePost({ authorId: author._id, visibility: 'private' });

    await expect(assertVisibility(post, author)).resolves.toBeUndefined();
  });

  it('allows followers to read follower-only posts', async () => {
    const viewer = makeUser();
    const authorId = new Types.ObjectId();
    const post = makePost({ authorId, visibility: 'followers' });

    vi.spyOn(Follow, 'exists').mockResolvedValue(true as never);

    await expect(assertVisibility(post, viewer)).resolves.toBeUndefined();
  });
});
