import { env } from '../config/env';
import { Post, type PostDocument } from '../models/post.model';
import { Comment, type CommentDocument } from '../models/comment.model';
import { Tag, type TagDocument } from '../models/tag.model';
import type { PostDTOContext, CommentDTOContext } from './dto';

const TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';

function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

function needsTranslation(text: string, targetLang: string): boolean {
  if (!text.trim()) return false;
  const isChinese = hasChinese(text);
  if (targetLang === 'zh' && isChinese) return false;
  if (targetLang === 'en' && !isChinese) return false;
  return true;
}

async function translateBatch(texts: string[], targetLang: string): Promise<string[]> {
  if (texts.length === 0) return [];
  const apiLang = targetLang === 'zh' ? 'zh-CN' : targetLang;
  const res = await fetch(`${TRANSLATE_URL}?key=${env.GOOGLE_TRANSLATE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, target: apiLang, format: 'text' }),
  });
  if (!res.ok) return texts;
  const data = (await res.json()) as {
    data: { translations: Array<{ translatedText: string }> };
  };
  return data.data.translations.map((t) => t.translatedText);
}

export async function translatePosts(
  posts: PostDocument[],
  ctxById: Map<string, PostDTOContext>,
  targetLang: string,
): Promise<void> {
  if (!env.GOOGLE_TRANSLATE_API_KEY) return;

  const pending: PostDocument[] = [];

  for (const post of posts) {
    const id = post._id.toString();
    if (!post.text?.trim()) continue;

    const cached = post.translations?.[targetLang];
    if (cached) {
      const ctx = ctxById.get(id);
      if (ctx) {
        ctx.translatedText = cached;
        ctx.originalLang = hasChinese(post.text) ? 'zh' : 'en';
      }
      continue;
    }

    if (needsTranslation(post.text, targetLang)) {
      pending.push(post);
    }
  }

  if (pending.length > 0) {
    try {
      const translated = await translateBatch(
        pending.map((p) => p.text),
        targetLang,
      );

      const bulkOps: Array<{
        updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> };
      }> = [];

      for (let i = 0; i < pending.length; i++) {
        const post = pending[i];
        const translatedText = translated[i];
        if (translatedText && translatedText !== post.text) {
          const ctx = ctxById.get(post._id.toString());
          if (ctx) {
            ctx.translatedText = translatedText;
            ctx.originalLang = hasChinese(post.text) ? 'zh' : 'en';
          }
          bulkOps.push({
            updateOne: {
              filter: { _id: post._id },
              update: { $set: { [`translations.${targetLang}`]: translatedText } },
            },
          });
        }
      }

      if (bulkOps.length > 0) {
        Post.bulkWrite(bulkOps).catch(() => undefined);
      }
    } catch {
      // Translation API failed — originals will be used
    }
  }

  // Also translate tags embedded in post contexts
  const uniqueTags: TagDocument[] = [];
  const seenSlugs = new Set<string>();
  for (const ctx of ctxById.values()) {
    for (const tag of ctx.tags) {
      if (!seenSlugs.has(tag.slug)) {
        seenSlugs.add(tag.slug);
        uniqueTags.push(tag);
      }
    }
  }
  if (uniqueTags.length > 0) {
    await translateTags(uniqueTags, targetLang);
  }

  for (const ctx of ctxById.values()) {
    ctx.lang = targetLang;
  }
}

export async function translateComments(
  comments: CommentDocument[],
  ctxByCommentId: Map<string, CommentDTOContext>,
  targetLang: string,
): Promise<void> {
  if (!env.GOOGLE_TRANSLATE_API_KEY) return;

  const pending: CommentDocument[] = [];

  for (const comment of comments) {
    const id = comment._id.toString();
    if (!comment.text?.trim() || comment.status === 'deleted') continue;

    const cached = comment.translations?.[targetLang];
    if (cached) {
      const ctx = ctxByCommentId.get(id);
      if (ctx) ctx.translatedText = cached;
      continue;
    }

    if (needsTranslation(comment.text, targetLang)) {
      pending.push(comment);
    }
  }

  if (pending.length === 0) return;

  try {
    const translated = await translateBatch(
      pending.map((c) => c.text),
      targetLang,
    );

    const bulkOps: Array<{
      updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> };
    }> = [];

    for (let i = 0; i < pending.length; i++) {
      const comment = pending[i];
      const translatedText = translated[i];
      if (translatedText && translatedText !== comment.text) {
        const ctx = ctxByCommentId.get(comment._id.toString());
        if (ctx) ctx.translatedText = translatedText;
        bulkOps.push({
          updateOne: {
            filter: { _id: comment._id },
            update: { $set: { [`translations.${targetLang}`]: translatedText } },
          },
        });
      }
    }

    if (bulkOps.length > 0) {
      Comment.bulkWrite(bulkOps).catch(() => undefined);
    }
  } catch {
    // Translation API failed
  }
}

export async function translateTags(
  tags: TagDocument[],
  targetLang: string,
): Promise<void> {
  if (!env.GOOGLE_TRANSLATE_API_KEY) return;

  const pending: TagDocument[] = [];

  for (const tag of tags) {
    if (tag.translations?.[targetLang]) continue;
    if (needsTranslation(tag.display, targetLang)) {
      pending.push(tag);
    }
  }

  if (pending.length === 0) return;

  try {
    const translated = await translateBatch(
      pending.map((t) => t.display),
      targetLang,
    );

    const bulkOps: Array<{
      updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> };
    }> = [];

    for (let i = 0; i < pending.length; i++) {
      const tag = pending[i];
      const translatedDisplay = translated[i];
      if (translatedDisplay && translatedDisplay !== tag.display) {
        if (!tag.translations) (tag as unknown as Record<string, unknown>).translations = {};
        tag.translations[targetLang] = translatedDisplay;
        bulkOps.push({
          updateOne: {
            filter: { _id: tag._id },
            update: { $set: { [`translations.${targetLang}`]: translatedDisplay } },
          },
        });
      }
    }

    if (bulkOps.length > 0) {
      Tag.bulkWrite(bulkOps).catch(() => undefined);
    }
  } catch {
    // Translation API failed
  }
}
