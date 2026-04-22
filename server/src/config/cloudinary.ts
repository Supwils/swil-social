import { v2 as cloudinary } from 'cloudinary';
import { env, cloudinaryEnabled } from './env';
import { logger } from '../lib/logger';

if (cloudinaryEnabled) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  logger.info('cloudinary configured');
} else {
  logger.warn('cloudinary not configured — image uploads will fail');
}

export { cloudinary, cloudinaryEnabled };

export async function uploadBufferToCloudinary(
  buffer: Buffer,
  folder: string,
): Promise<{ url: string; width: number; height: number }> {
  if (!cloudinaryEnabled) {
    throw new Error('Cloudinary not configured');
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('upload failed'));
        resolve({
          url: result.secure_url,
          width: result.width,
          height: result.height,
        });
      },
    );
    stream.end(buffer);
  });
}
