import { io, type Socket } from 'socket.io-client';

/**
 * Socket.io client singleton.
 *
 * Handshake reuses the `sid` cookie (same-origin via Vite proxy in dev, same-
 * origin in prod). Connect is explicit: `connectRealtime()` after `/auth/me`
 * resolves with a user, `disconnectRealtime()` on logout or 401.
 */

let socket: Socket | null = null;

export function connectRealtime(): Socket {
  if (socket && socket.connected) return socket;
  if (!socket) {
    socket = io('/', {
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
  | 'post:new';

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
