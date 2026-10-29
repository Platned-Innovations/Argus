import { useState } from 'react';
import { useSearchParams } from 'react-router';

export interface FilterState {
  params: URLSearchParams;
  /** Sets one filter ('' removes it). Typing (`replace`) does not add a browser history entry per keystroke. */
  set(key: string, value: string, opts?: { replace?: boolean }): void;
  /** Replaces every filter, e.g. when a saved view is applied. */
  replaceAll(query: string): void;
}

/** List filters kept in the URL (so they can be bookmarked and saved as views), or in component state. */
export function useFilters(inUrl: boolean, onChange?: () => void): FilterState {
  const [urlParams, setUrlParams] = useSearchParams();
  const [localParams, setLocalParams] = useState(() => new URLSearchParams());
  const params = inUrl ? urlParams : localParams;
  const apply = (next: URLSearchParams, replace = false) => {
    if (inUrl) setUrlParams(next, { replace });
    else setLocalParams(next);
    onChange?.();
  };
  return {
    params,
    set: (key, value, opts) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      apply(next, opts?.replace);
    },
    replaceAll: (query) => apply(new URLSearchParams(query)),
  };
}
