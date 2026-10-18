import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

// A label's trailing aside — "(optional)", "(MB)", "(leave blank for any)" — is quieter
// than the label itself, as the wizard's hints are: "Memory" in the label's weight, "(MB)"
// muted. Text without one renders as it was.
export function LabelText({ text }: { text: string }) {
  const m = text.match(/^(.*\S)\s+(\([^()]*\))$/);
  if (!m) return <>{text}</>;
  return <>{m[1]} <span className="font-normal text-muted-foreground">{m[2]}</span></>;
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className, id, ...rest }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-[13px] font-semibold text-foreground">
            <LabelText text={label} />
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'block h-9 w-full rounded-md border border-input bg-field px-3 text-[13.5px] text-foreground placeholder:text-muted-foreground/70',
            'transition-[border-color,box-shadow] duration-150 hover:border-muted-foreground/40 focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50',
            error && 'border-destructive',
            className
          )}
          {...rest}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }
);
Input.displayName = 'Input';
