import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export function LoginPage() {
  const navigate = useNavigate();
  const setToken = useAuthStore((s) => s.setToken);

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post<{ token: string }>('/api/auth/login', { password });
      setToken(data.token);
      navigate('/', { replace: true });
    } catch {
      setError('Invalid password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-2xl ring-1 ring-primary/25"
            style={{ background: 'linear-gradient(135deg, hsl(214 100% 62% / 0.3), hsl(214 100% 62% / 0.08))' }}
          >
            <Cpu size={22} className="text-primary" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold tracking-tight text-foreground">VirtPilot</h1>
            <p className="mt-0.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
              KVM Manager
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-border/60 bg-card/60 p-6 shadow-lg backdrop-blur-sm">
          <div className="mb-5 flex items-center gap-2">
            <Lock size={14} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Sign in</h2>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Input
                label="Password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                error={error}
                autoFocus
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-[26px] text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? <Loader2 size={14} className="animate-spin" /> : null}
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
