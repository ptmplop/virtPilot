import { useEffect, useState, useRef, type FormEvent, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/ui/Button';
import { APP_VERSION } from '@/components/layout/Layout';

function ipBlockedMessage(err: unknown): string | null {
  if (!axios.isAxiosError(err) || err.response?.status !== 403) return null;
  const ip = (err.response.data as { clientIp?: string })?.clientIp;
  return ip
    ? `Access denied — your IP address ${ip} is not on the allowlist. Contact your administrator.`
    : 'Access denied — your IP address is not on the allowlist. Contact your administrator.';
}

type Step = 'password' | 'totp';

export function LoginPage() {
  const navigate = useNavigate();
  const setToken = useAuthStore((s) => s.setToken);

  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [tempToken, setTempToken] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const totpInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { document.title = 'Sign in · VirtPilot'; }, []);

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post<{ token?: string; requiresTotp?: boolean; tempToken?: string }>(
        '/api/auth/login',
        { password },
      );
      if (data.requiresTotp && data.tempToken) {
        setTempToken(data.tempToken);
        setStep('totp');
        setTimeout(() => totpInputRef.current?.focus(), 50);
      } else if (data.token) {
        setToken(data.token);
        navigate('/', { replace: true });
      }
    } catch (err) {
      setError(ipBlockedMessage(err) ?? 'Invalid password.');
    } finally {
      setLoading(false);
    }
  }

  async function handleTotpSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post<{ token: string }>('/api/auth/verify-totp', {
        tempToken,
        code: totpCode,
      });
      setToken(data.token);
      navigate('/', { replace: true });
    } catch (err) {
      const ipMsg = ipBlockedMessage(err);
      if (ipMsg) {
        setError(ipMsg);
      } else {
        setError('Invalid authenticator code.');
        setTotpCode('');
        totpInputRef.current?.focus();
      }
    } finally {
      setLoading(false);
    }
  }

  function handleTotpInput(e: ChangeEvent<HTMLInputElement>) {
    const val = e.target.value.replace(/\D/g, '').slice(0, 6);
    setTotpCode(val);
  }

  const fieldClass =
    'block h-10 w-full rounded-md border border-input bg-field px-3 text-[14px] text-foreground ' +
    'placeholder:text-muted-foreground/70 transition-[border-color,box-shadow] duration-150 ' +
    'hover:border-muted-foreground/40 focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/20';

  return (
    // The sign-in screen is the canvas with one sheet on it — the same frame as the app.
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-12 text-foreground">
      <div className="w-full max-w-[380px] animate-fade-in">
        <div className="mb-9 flex flex-col items-center">
          <img src="/brand/virtpilot-horizontal.svg" alt="VirtPilot" className="h-[38px] w-auto dark:hidden" />
          <img src="/brand/virtpilot-horizontal-dark.svg" alt="VirtPilot" className="hidden h-[38px] w-auto dark:block" />
          <p className="mt-3 text-[13px] text-muted-foreground">KVM, steered from the browser</p>
        </div>

        <div className="rounded-[12px] border border-sheet-border bg-card p-8 shadow-[0_1px_2px_rgb(27_36_51/0.05),0_12px_32px_-16px_rgb(27_36_51/0.18)] dark:shadow-none">
          {step === 'password' ? (
            <>
              <h1 className="text-[20px] font-semibold tracking-[-0.018em] text-foreground">Sign in</h1>
              <p className="mt-1 text-[13.5px] text-muted-foreground">Enter the admin password for this host.</p>

              <form onSubmit={handlePasswordSubmit} className="mt-6 space-y-5">
                <div className="space-y-1.5">
                  <label htmlFor="login-password" className="block text-[13px] font-semibold text-foreground">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      autoFocus
                      required
                      className={fieldClass + ' pr-10'}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      tabIndex={-1}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute inset-y-0 right-3 flex items-center text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  {error && <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
                </div>

                <Button type="submit" disabled={loading} className="h-10 w-full">
                  {loading && <Spinner className="h-3.5 w-3.5 text-primary-foreground" />}
                  {loading ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} className="text-primary" />
                <h1 className="text-[20px] font-semibold tracking-[-0.018em] text-foreground">Two-factor authentication</h1>
              </div>
              <p className="mt-1 text-[13.5px] text-muted-foreground">
                Enter the 6-digit code from your authenticator app.
              </p>

              <form onSubmit={handleTotpSubmit} className="mt-6 space-y-5">
                <div className="space-y-1.5">
                  <label htmlFor="login-totp" className="block text-[13px] font-semibold text-foreground">
                    Authenticator code
                  </label>
                  <input
                    id="login-totp"
                    ref={totpInputRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={totpCode}
                    onChange={handleTotpInput}
                    placeholder="000000"
                    required
                    maxLength={6}
                    className={fieldClass + ' text-center font-mono text-lg tracking-[0.35em]'}
                  />
                  {error && <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
                </div>

                <Button type="submit" disabled={loading || totpCode.length !== 6} className="h-10 w-full">
                  {loading && <Spinner className="h-3.5 w-3.5 text-primary-foreground" />}
                  {loading ? 'Verifying…' : 'Verify'}
                </Button>

                <button
                  type="button"
                  onClick={() => { setStep('password'); setError(''); setTotpCode(''); }}
                  className="w-full text-center text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  Back to password
                </button>
              </form>
            </>
          )}
        </div>

        <p className="mt-8 text-center font-mono text-[11.5px] text-muted-foreground">
          VirtPilot {APP_VERSION}
        </p>
      </div>
    </div>
  );
}
