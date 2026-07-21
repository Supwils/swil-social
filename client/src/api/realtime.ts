import { io, type Socket } from 'socket.io-client';

/**
 * Socket.io client singleton.
 *
 * Handshake reuses the `sid` cookie. Same-origin by default (`/`); set
 * `VITE_SOCKET_URL` at build time to point at a cross-origin backend (e.g. the
 * Railway API when the SPA is hosted separately on Vercel).
 */

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || '/';

let socket: Socket | null = null;

export function connectRealtime(): Socket {
  if (socket && socket.connected) return socket;
  if (!socket) {
    socket = io(SOCKET_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
  }
  socket.connect();
  return socket;
}

export function disconnectRealtime(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

export function getSocket(): Socket | null {
  return socket;
}

/**
 * Typed event helpers. Not exhaustive — add as we need more.
 */
export type RealtimeEvent =
  | 'notification'
  | 'notification:read'
  | 'message'
  | 'message:read'
  | 'conversation:update'
  | 'post:new'
  | 'typing'
  | 'typing:end';

export function on(event: RealtimeEvent, listener: (payload: unknown) => void): () => void {
  const s = socket;
  if (!s) return () => undefined;
  s.on(event, listener);
  return () => {
    s.off(event, listener);
  };
}

export function emit(event: string, payload?: unknown, ack?: (ok: boolean) => void): void {
  socket?.emit(event, payload ?? {}, ack);
}

export function emitTyping(conversationId: string): void {
  socket?.emit('typing', { conversationId });
}

export function emitTypingEnd(conversationId: string): void {
  socket?.emit('typing:end', { conversationId });
}
