import { useEffect, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { resumeTemplateSetDownloadIfNeeded } from '@/lib/templateSetDownloader';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);

  // Fire once after auth is established. The downloader checks its own
  // single-instance guard, so multiple ProtectedRoute mounts (one per route
  // entry) won't spawn parallel runs. Only fires when localStorage already
  // holds an unfinished templateBulk — otherwise it's a cheap no-op.
  useEffect(() => {
    if (!token) return;
    void resumeTemplateSetDownloadIfNeeded();
  }, [token]);

  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
