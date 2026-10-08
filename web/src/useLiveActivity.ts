import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { liveUrl, parseActivityDetail, type ActivityDetail } from './api';

export function useLiveActivity(id: string, detail: ActivityDetail | null, setDetail: Dispatch<SetStateAction<ActivityDetail | null>>) {
  const [status, setStatus] = useState('Connecting to live availability…');
  const [stale, setStale] = useState(true);
  const [received, setReceived] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const acknowledgements = useRef(new Map<string, number>());
  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastSnapshot = 0;
    let backoff = 500;
    const clientId = crypto.randomUUID();
    function connect() {
      if (stopped) return;
      setStatus('Connecting to live availability… Details may be stale.'); setStale(true);
      lastSnapshot = Date.now();
      let current: WebSocket;
      try { current = new WebSocket(liveUrl()); }
      catch { setStatus('Live connection unavailable. Details may be stale.'); retry = setTimeout(connect, backoff); backoff = Math.min(3000, backoff * 2); return; }
      socket.current = current;
      current.onopen = () => {
        if (stopped || socket.current !== current) return;
        current.send(JSON.stringify({ type: 'subscribe', activityId: id, clientId, foreground: document.visibilityState !== 'hidden' }));
      };
      current.onmessage = event => {
        if (stopped || socket.current !== current) return;
        try {
          const message = JSON.parse(String(event.data));
          if (message.type !== 'snapshot') throw new Error('Snapshot unavailable');
          const activity = parseActivityDetail(message.activity);
          if (activity.id !== id || message.activityId !== id || message.version !== activity.version ||
              (message.eventId !== null && typeof message.eventId !== 'string')) throw new Error('Invalid live snapshot');
          lastSnapshot = Date.now(); backoff = 500;
          setDetail(previous => !previous || activity.version > previous.version ? activity : previous);
          if (message.eventId) acknowledgements.current.set(message.eventId, activity.version);
          setReceived(value => value + 1);
          setStale(false); setStatus('Live availability connected.');
        } catch {
          setStale(true); setStatus('Live details are unavailable. Details may be stale.');
        }
      };
      current.onerror = () => { if (stopped || socket.current !== current) return; setStale(true); setStatus('Live connection interrupted. Details may be stale.'); };
      current.onclose = () => {
        if (stopped || socket.current !== current) return;
        socket.current = null;
        acknowledgements.current.clear();
        setStale(true); setStatus('Live connection interrupted. Reconnecting; details may be stale.');
        retry = setTimeout(connect, backoff); backoff = Math.min(3000, backoff * 2);
      };
    }
    function foreground() {
      const current = socket.current;
      if (document.visibilityState === 'hidden') { setStale(true); setStatus('Live updates paused while this page is hidden.'); }
      else { lastSnapshot = Date.now(); setStale(true); setStatus('Refreshing live availability…'); }
      if (current?.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'foreground', foreground: document.visibilityState !== 'hidden' }));
    }
    const watchdog = setInterval(() => {
      if (document.visibilityState !== 'hidden' && Date.now() - lastSnapshot > 5000) {
        setStale(true); setStatus('Live updates delayed. Reconnecting; details may be stale.'); socket.current?.close();
      }
    }, 1000);
    document.addEventListener('visibilitychange', foreground);
    connect();
    return () => {
      stopped = true; clearTimeout(retry); clearInterval(watchdog);
      document.removeEventListener('visibilitychange', foreground);
      acknowledgements.current.clear(); socket.current?.close(); socket.current = null;
    };
  }, [id, setDetail]);
  // Effects run after the committed DOM contains this version and its participants.
  useEffect(() => {
    const current = socket.current;
    if (!detail || document.visibilityState === 'hidden' || current?.readyState !== WebSocket.OPEN) return;
    for (const [eventId, version] of acknowledgements.current) {
      if (detail.version < version) continue;
      current.send(JSON.stringify({ type: 'ack', eventId, activityId: id, version }));
      acknowledgements.current.delete(eventId);
    }
  }, [detail, received, id]);
  return { status, stale };
}
