import { useEffect, useState } from 'react';

/**
 * Debounce a rapidly-changing value.
 *
 * Used for the employee search box: without it every keystroke would issue a
 * request, which is wasteful against a server-side search and noisy in the
 * network log.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
