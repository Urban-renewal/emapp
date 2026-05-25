'use client';

import { ImportSseEventSchema, type ImportSseEvent } from '@emapp/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

/**
 * useImportProgress(importId) — opens a same-origin EventSource on
 * `/api/v1/imports/:id/stream` and streams the live progress frames.
 *
 * Per docs/ARCHITECTURE-MAP §8 + shared-types/import.ts:
 *  - Each frame is JSON, validated by `ImportSseEventSchema.parse`
 *    on every line (Doc 11 — defensive parse, never trust the wire).
 *  - 3 discriminated variants:
 *      progress — update counters, keep going
 *      end     — terminal (done/failed/cancelled), close stream
 *      gone    — row no longer visible (cancelled-archive from
 *                another tab), close stream
 *  - Native EventSource auto-reconnects with browser-default backoff
 *    on network drops (D.36 caveat: documented). We do NOT add a
 *    custom retry layer — the browser handles transient drops; on
 *    repeated failure the EventSource enters CLOSED state and our
 *    `connected: false` reflects that.
 *  - On terminal frames, we ALSO invalidate the TanStack cache so
 *    the parent `useImport(id)` re-fetches the canonical row from
 *    the API (the SSE-summary numbers may differ slightly from the
 *    DB row's persisted counters at the exact COMMIT moment).
 *
 * Returns:
 *   - `event`   — last parsed frame (null until the first arrives)
 *   - `terminal` — true once 'end' or 'gone' has been received
 *   - `connected` — EventSource.readyState === OPEN
 *   - `error`   — parse error or stream error string (most recent only)
 */
export interface ImportProgressState {
  event: ImportSseEvent | null;
  terminal: boolean;
  connected: boolean;
  error: string | null;
}

export function useImportProgress(importId: string | undefined): ImportProgressState {
  const qc = useQueryClient();
  const [event, setEvent] = useState<ImportSseEvent | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!importId) return;
    // §RED-6 closure — UUID-validate the importId before opening the
    // EventSource. The id comes from `useParams()` which is URL-
    // controlled; a path-traversal payload (`..%2fadmin`) or a
    // mistyped url would otherwise open a useless SSE that ties up
    // a per-process slot until backend rejection. Pin shape early.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(importId)) {
      setError('invalid_id_shape');
      return;
    }
    // Reset on id change
    setEvent(null);
    setTerminal(false);
    setError(null);

    // EventSource is browser-native; goes through the Pages Function
    // proxy (route.ts) which streams `upstream.body` unchanged.
    const es = new EventSource(`/api/v1/imports/${importId}/stream`);
    sourceRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      // Browser-default reconnect handles transient drops. If the
      // EventSource transitions to CLOSED (final failure), we surface
      // it so the UI can show "lost connection — refresh".
      setConnected(es.readyState === EventSource.OPEN);
      if (es.readyState === EventSource.CLOSED) {
        setError('stream_closed');
      }
    };
    es.onmessage = (raw) => {
      try {
        const parsed = ImportSseEventSchema.parse(JSON.parse(raw.data));
        setEvent(parsed);
        if (parsed.event === 'end' || parsed.event === 'gone') {
          setTerminal(true);
          es.close();
          // Re-fetch the canonical row (counters at COMMIT, not the
          // SSE-summary mid-flight values).
          qc.invalidateQueries({ queryKey: ['imports', 'one', importId] });
          qc.invalidateQueries({ queryKey: ['imports', 'list'] });
        }
      } catch (e) {
        setError((e as Error).message || 'invalid_sse_frame');
      }
    };

    return () => {
      es.close();
      sourceRef.current = null;
    };
  }, [importId, qc]);

  return { event, terminal, connected, error };
}
