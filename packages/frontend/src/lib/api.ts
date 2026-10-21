import axios from 'axios';

export const api = axios.create({
  baseURL: '',
  timeout: 30_000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('virtpilotToken');
  if (token) config.headers['Authorization'] = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('virtpilotToken');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

/**
 * The server's own words for a failed request, when it sent any: a VM that
 * won't start because of a passed-through device says which and why, and
 * "Request failed with status code 409" helps nobody.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: unknown } } } | undefined;
  const msg = e?.response?.data?.error;
  return typeof msg === 'string' && msg.trim() ? msg.replace(/^(?:Error|DeviceError): /, '') : fallback;
}
