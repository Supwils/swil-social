/** Multer ceiling for any one file (image or video) on POST /posts. */
export const POST_UPLOAD_FILE_SIZE = 15 * 1024 * 1024;

/** Write-path image cap. Multer still buffers up to POST_UPLOAD_FILE_SIZE;
 *  this check then rejects oversized images with a validation error. */
export const POST_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
