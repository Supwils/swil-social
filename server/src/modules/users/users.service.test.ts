import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { UserDocument } from '../../models/user.model';
import * as s3 from '../../config/s3';
import { updateAvatar, updateMe } from './users.service';

function makeUser(): UserDocument {
  return {
    _id: new Types.ObjectId(),
    id: new Types.ObjectId().toString(),
    displayName: 'Ada',
    bio: '',
    headline: '',
    avatarUrl: 'https://cdn.example.com/old-avatar.webp',
    location: null,
    website: null,
    birthdate: null,
    profileTags: [],
    preferences: {
      toObject: () => ({
        theme: 'system',
        language: 'en',
        emailNotifications: true,
        pushNotifications: true,
      }),
    },
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as UserDocument;
}

describe('users.service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges preferences and normalizes profile tags on update', async () => {
    const user = makeUser();

    await updateMe(user, {
      displayName: 'Ada Lovelace',
      preferences: { language: 'zh' },
      profileTags: [' AI ', 'Builder'],
    });

    expect(user.displayName).toBe('Ada Lovelace');
    expect(user.preferences).toMatchObject({
      theme: 'system',
      language: 'zh',
      emailNotifications: true,
      pushNotifications: true,
    });
    expect(user.profileTags).toEqual(['ai', 'builder']);
    expect(user.save).toHaveBeenCalledOnce();
  });

  it('uploads a new avatar and deletes the old one after save', async () => {
    const user = makeUser();

    vi.spyOn(s3, 'uploadBufferToS3').mockResolvedValue({
      url: 'https://cdn.example.com/new-avatar.webp',
      width: 256,
      height: 256,
    });
    const remove = vi.spyOn(s3, 'deleteFromS3').mockResolvedValue(undefined);

    await updateAvatar(user, Buffer.from('avatar'));

    expect(user.avatarUrl).toBe('https://cdn.example.com/new-avatar.webp');
    expect(user.save).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('https://cdn.example.com/old-avatar.webp');
  });
});
