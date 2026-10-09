import { useEffect, useRef, useState } from 'react';

/**
 * Tweens a displayed number towards `target` with an ease-out curve. Animates
 * from the currently-shown value, so it gives a count-up on mount and a smooth
 * glide when the value changes on each poll. Honours `prefers-reduced-motion`
 * by snapping instantly.
 */
export function useCountUp(target: number, duration = 700, initial = 0): number {
  // Starts at `initial` (0 by default, so a first appearance counts up); later target
  // changes glide from the currently-shown value. Pass the target itself as `initial`
  // to show the true reading at once and only animate real changes.
  const [value, setValue] = useState(initial);
  const valueRef = useRef(0);
  valueRef.current = value;
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const from = valueRef.current;
    if (reduce || from === target) {
      setValue(target);
      return;
    }

    let start: number | null = null;
    const step = (t: number) => {
      if (start === null) start = t;
      const p = Math.min((t - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setValue(from + (target - from) * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return value;
}
