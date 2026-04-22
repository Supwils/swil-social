/**
 * Socket.io bootstrap.
 *
 * Handshake reuses the Express session cookie — the browser sends `sid`
 * automatically on same-origin WebSocket upgrade. We pipe the session middleware
 * into the engine so `socket.request.session.userId` is populated.
 *
 * Unauthenticated sockets are rejected at connection. Authenticated sockets
 * auto-join a personal room `user:<userId>` for notifications and DMs. Rooms
 * for specific conversations are joined only after a server-side membership
 * check (see handlers below).
 */
import { Server as IOServer } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { Conversation } from '../models/conversation.model';
import { Types } from 'mongoose';

/**
 * Zod schemas for inbound socket events. Malformed payloads are dropped
 * quietly (ack: false if an ack is provided). Keeps the attack surface tight
 * without noisy errors for clients that may reconnect with stale state.
 */
const conversationIdSchema = z.object({
  conversationId: z
    .string()
    .regex(/^[a-f0-9]{24}$/, 'Invalid conversationId'),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T | null {
  const result = schema.safeParse(input);
  return result.success ? result.data : null;
}

type SessionedRequest = Parameters<RequestHandler>[0] & {
  session?: { userId?: string };
};

let io: IOServer | null = null;

export function initRealtime(httpServer: HttpServer, sessionMiddleware: RequestHandler): IOServer {
  const server = new IOServer(httpServer, {
    cors: { credentials: true },
    transports: ['websocket', 'polling'],
  });

  // Reuse the same express-session middleware — required so `socket.request.session` is set.
  server.engine.use(sessionMiddleware as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void);

  server.use((socket, next) => {
    const req = socket.request as SessionedRequest;
    const userId = req.session?.userId;
    if (!userId) {
      next(new Error('unauthenticated'));
      return;
    }
    socket.data.userId = userId;
    next();
  });

  server.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    socket.join(userRoom(userId));
    logger.debug({ userId, sid: socket.id }, 'socket connected');

    socket.on('conversation:join', async (raw: unknown, ack?: (ok: boolean) => void) => {
      try {
        const parsed = parse(conversationIdSchema, raw);
        if (!parsed) {
          ack?.(false);
          return;
        }
        const allowed = await isConversationMember(parsed.conversationId, userId);
        if (!allowed) {
          ack?.(false);
          return;
        }
        socket.join(conversationRoom(parsed.conversationId));
        ack?.(true);
      } catch (err) {
        logger.error({ err }, 'conversation:join failed');
        ack?.(false);
      }
    });

    socket.on('conversation:leave', (raw: unknown) => {
      const parsed = parse(conversationIdSchema, raw);
      if (parsed) socket.leave(conversationRoom(parsed.conversationId));
    });

    socket.on('disconnect', () => {
      logger.debug({ userId, sid: socket.id }, 'socket disconnected');
    });
  });

  io = server;
  return server;
}

export function getIO(): IOServer | null {
  return io;
}

export function userRoom(userId: string | Types.ObjectId): string {
  return `user:${userId.toString()}`;
}

export function conversationRoom(conversationId: string | Types.ObjectId): string {
  return `conversation:${conversationId.toString()}`;
}

export function emitToUser(userId: string | Types.ObjectId, event: string, payload: unknown): void {
  if (!io) return;
  io.to(userRoom(userId)).emit(event, payload);
}

export function emitToConversation(
  conversationId: string | Types.ObjectId,
  event: string,
  payload: unknown,
): void {
  if (!io) return;
  io.to(conversationRoom(conversationId)).emit(event, payload);
}

async function isConversationMember(conversationId: string, userId: string): Promise<boolean> {
  const hit = await Conversation.exists({
    _id: new Types.ObjectId(conversationId),
    participantIds: new Types.ObjectId(userId),
  });
  return Boolean(hit);
}
