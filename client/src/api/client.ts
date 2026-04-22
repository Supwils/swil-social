import axios, { AxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import type { ApiEnvelope, ApiError } from './types';

/**
 * Axios instance.
 *
 * Base URL is `/api/v1` in all environments; Vite proxies `/api` → :8888 in dev,
 * and in prod the static build is served by the API host itself.
 */
export const http: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api/v1',
  withCredentials: true,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

// ---- error normalization --------------------------------------------------

export function toApiError(err: unknown): ApiError {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError<{
      error?: {
        code?: string;
        message?: string;
        fields?: Record<string, string>;
        requestId?: string;
      };
    }>;
    const payload = ax.response?.data?.error;
    if (payload) {
      return {
        code: (payload.code as ApiError['code']) ?? 'UNKNOWN',
        message: payload.message ?? 'Request failed',
        fields: payload.fields,
        requestId: payload.requestId,
        status: ax.response?.status ?? 0,
      };
    }
    if (ax.code === 'ECONNABORTED' || ax.code === 'ERR_NETWORK') {
      return {
        code: 'NETWORK',
        message: 'Cannot reach the server. Check your connection.',
        status: 0,
      };
    }
    return {
      code: 'UNKNOWN',
      message: ax.message || 'Request failed',
      status: ax.response?.status ?? 0,
    };
  }
  if (err instanceof Error) {
    return { code: 'UNKNOWN', message: err.message, status: 0 };
  }
  return { code: 'UNKNOWN', message: 'Unknown error', status: 0 };
}

// ---- 401 handling: coordinate session store + router ---------------------

type UnauthorizedListener = () => void;
let unauthorizedListener: UnauthorizedListener | null = null;

export function onUnauthorized(fn: UnauthorizedListener): void {
  unauthorizedListener = fn;
}

http.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401 && unauthorizedListener) {
      // Defer so the interceptor doesn't hold up the axios promise chain
      queueMicrotask(() => unauthorizedListener?.());
    }
    return Promise.reject(err);
  },
);

// ---- envelope unwrapping helper ------------------------------------------

export async function unwrap<T>(p: Promise<AxiosResponse<ApiEnvelope<T>>>): Promise<T> {
  try {
    const res = await p;
    return res.data.data;
  } catch (err) {
    throw toApiError(err);
  }
}
