import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
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
    <div
      className="dark relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4"
      style={{ backgroundColor: 'hsl(222 28% 5%)' }}
    >
      {/* Dot grid */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, hsl(214 100% 62% / 0.12) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />

      {/* Blue bloom from top */}
      <div
        className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[900px] -translate-x-1/2"
        style={{
          background:
            'radial-gradient(ellipse at 50% 0%, hsl(214 100% 62% / 0.18) 0%, transparent 65%)',
        }}
      />

      {/* Hairline top edge glow */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

      {/* Corner brackets */}
      <div className="pointer-events-none absolute inset-6 sm:inset-10">
        <div className="absolute left-0 top-0 h-8 w-8 border-l border-t border-primary/15" />
        <div className="absolute right-0 top-0 h-8 w-8 border-r border-t border-primary/15" />
        <div className="absolute bottom-0 left-0 h-8 w-8 border-b border-l border-primary/15" />
        <div className="absolute bottom-0 right-0 h-8 w-8 border-b border-r border-primary/15" />
      </div>

      {/* Content */}
      <div className="relative z-10 w-full max-w-[340px] animate-slide-up">

        {/* Logo + tagline */}
        <div className="mb-10 flex flex-col items-center gap-3">
          <img src="/vlogo-big.png" alt="VirtPilot" className="h-9 w-auto drop-shadow-lg" />
          <div className="flex items-center gap-2.5">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-white/10" />
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground/70">
              KVM Manager
            </p>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-white/10" />
          </div>
        </div>

        {/* Card */}
        <div
          className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-card/70 p-7 backdrop-blur-md"
          style={{
            boxShadow:
              '0 0 0 1px hsl(214 100% 62% / 0.1), 0 32px 80px hsl(222 28% 3% / 0.7), 0 8px 24px hsl(222 28% 3% / 0.4)',
          }}
        >
          {/* Top inset glow line */}
          <div
            className="absolute inset-x-0 top-0 h-px"
            style={{
              background:
                'linear-gradient(90deg, transparent 0%, hsl(214 100% 62% / 0.5) 50%, transparent 100%)',
            }}
          />

          {/* Heading */}
          <div className="mb-6 flex items-center gap-3">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
              style={{
                background:
                  'linear-gradient(135deg, hsl(214 100% 62% / 0.2), hsl(214 100% 62% / 0.06))',
                boxShadow: 'inset 0 0 0 1px hsl(214 100% 62% / 0.2)',
              }}
            >
              <Lock size={13} className="text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Authenticate</h2>
              <p className="text-[11px] leading-tight text-muted-foreground">
                Enter your admin password
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  autoFocus
                  required
                  className="block w-full rounded-lg border border-input bg-background py-2 pl-3 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                  className="absolute inset-y-0 right-3 flex items-center text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>

            <Button type="submit" disabled={loading} className="w-full">
              {loading && <Loader2 size={14} className="animate-spin" />}
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>

        {/* Footer */}
        <div className="mt-7 flex items-center justify-center gap-3">
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/60">
            <span
              className="h-1.5 w-1.5 rounded-full bg-emerald-400"
              style={{ boxShadow: '0 0 6px 1px rgb(52 211 153 / 0.45)' }}
            />
            System online
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="font-mono text-[10px] text-muted-foreground/60">v1.3.0</span>
        </div>
      </div>
    </div>
  );
}
