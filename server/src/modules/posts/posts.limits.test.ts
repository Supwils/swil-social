import { describe, expect, it } from 'vitest';
import { POST_IMAGE_MAX_BYTES, POST_UPLOAD_FILE_SIZE } from './posts.limits';

describe('post upload ceilings', () => {
  it('keeps the multer ceiling above the image cap and far below the old 50 MB heap', () => {
    expect(POST_IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(POST_UPLOAD_FILE_SIZE).toBe(15 * 1024 * 1024);
    expect(POST_UPLOAD_FILE_SIZE).toBeGreaterThan(POST_IMAGE_MAX_BYTES);
    expect(POST_UPLOAD_FILE_SIZE).toBeLessThan(50 * 1024 * 1024);
  });
});
