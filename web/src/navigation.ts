import type { MouseEvent } from 'react';
import { useSyncExternalStore } from 'react';
export function navigate(path: string) {
  if (window.location.pathname === path) return;
  const previous = window.location.pathname;
  const returnTo = previous === '/hosting' || previous === '/activities/new' ? '/hosting' : previous === '/' ? '/' : window.history.state?.returnTo ?? '/';
  window.history.pushState({ returnTo }, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo?.({ top: 0 });
}
function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
export function usePath() { return useSyncExternalStore(subscribe, () => window.location.pathname); }

export function followRoute(event: MouseEvent<HTMLAnchorElement>, path: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
}
