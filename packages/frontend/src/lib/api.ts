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
