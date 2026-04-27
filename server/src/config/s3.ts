import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import sharp from 'sharp';
import { env, s3Enabled } from './env';
import { logger } from '../lib/logger';

export { s3Enabled };

export const s3 = s3Enabled
  ? new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      },
    })
  : null;

if (s3Enabled) {
  logger.info('S3 configured');
} else {
  logger.warn('S3 not configured — image uploads will fail');
}

function randomKey(folder: string, ext: string): string {
  return `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
}

function keyFromUrl(url: string): string {
  return url.replace(`${env.AWS_CLOUDFRONT_URL}/`, '');
}

export async function uploadBufferToS3(
  buffer: Buffer,
  folder: string,
): Promise<{ url: string; width: number; height: number }> {
  if (!s3) throw new Error('S3 not configured');

  // .rotate() with no args reads EXIF Orientation and bakes it into pixels —
  // without it, portrait phone photos save sideways once metadata is stripped.
  // sharp strips all metadata (incl. GPS) by default, so output is geo-clean.
  const compressed = await sharp(buffer)
    .rotate()
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();

  const meta = await sharp(compressed).metadata();
  const key = randomKey(folder, 'webp');

  await new Upload({
    client: s3,
    params: {
      Bucket: env.AWS_S3_BUCKET!,
      Key: key,
      Body: compressed,
      ContentType: 'image/webp',
    },
  }).done();

  return {
    url: `${env.AWS_CLOUDFRONT_URL}/${key}`,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  };
}

export async function uploadVideoBufferToS3(
  buffer: Buffer,
  folder: string,
): Promise<{ url: string; width: number; height: number }> {
  if (!s3) throw new Error('S3 not configured');

  const key = randomKey(folder, 'mp4');

  await new Upload({
    client: s3,
    params: {
      Bucket: env.AWS_S3_BUCKET!,
      Key: key,
      Body: buffer,
      ContentType: 'video/mp4',
    },
  }).done();

  return {
    url: `${env.AWS_CLOUDFRONT_URL}/${key}`,
    width: 0,
    height: 0,
  };
}

export async function deleteFromS3(url: string): Promise<void> {
  if (!s3 || !url.startsWith(env.AWS_CLOUDFRONT_URL ?? '')) return;
  const key = keyFromUrl(url);
  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: env.AWS_S3_BUCKET!,
      Key: key,
    }));
  } catch (err) {
    // Non-fatal: log but don't throw — the post/avatar delete should still succeed
    logger.warn({ err, key }, 'Failed to delete S3 object');
  }
}
