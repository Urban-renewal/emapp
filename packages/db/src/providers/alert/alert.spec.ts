import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoopAlertSink } from './noop.provider';
import { WebhookAlertSink } from './webhook.provider';

describe('NoopAlertSink', () => {
  it('records the last event for test inspection and never throws', async () => {
    const sink = new NoopAlertSink({ verbose: false });
    await sink.alert({ severity: 'warning', kind: 'k', summary: 's', meta: { count: 3 } });
    expect(sink.lastEvent?.kind).toBe('k');
    expect(sink.events).toHaveLength(1);
  });
});

describe('WebhookAlertSink (fail-safe)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs a PII-free body to the configured url', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const sink = new WebhookAlertSink({ url: 'https://hook.example/intake' });

    await sink.alert({ severity: 'critical', kind: 'k', summary: 's', meta: { count: 1 } });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hook.example/intake');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['kind']).toBe('k');
    expect(body['severity']).toBe('critical');
  });

  it('does NOT throw when the webhook rejects (fail-safe)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const sink = new WebhookAlertSink({ url: 'https://hook.example/intake', timeoutMs: 50 });
    await expect(
      sink.alert({ severity: 'info', kind: 'k', summary: 's' }),
    ).resolves.toBeUndefined();
  });

  it('does NOT throw on a non-2xx response (fail-safe)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    const sink = new WebhookAlertSink({ url: 'https://hook.example/intake' });
    await expect(
      sink.alert({ severity: 'info', kind: 'k', summary: 's' }),
    ).resolves.toBeUndefined();
  });
});
