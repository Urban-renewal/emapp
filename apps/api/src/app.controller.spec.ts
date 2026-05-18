import { describe, it, expect, vi, beforeEach } from 'vitest';

import { HealthController } from './app.controller';

vi.mock('@emapp/db', () => ({
  db: {
    execute: vi.fn().mockResolvedValue([]),
  },
  sql: vi.fn((strings: TemplateStringsArray) => strings.join('')),
}));

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(() => {
    controller = new HealthController();
  });

  it('returns status ok when db is connected', async () => {
    const result = await controller.getHealth();
    expect(result.status).toBe('ok');
    expect(result.db).toBe('connected');
    expect(typeof result.uptime).toBe('number');
    expect(typeof result.timestamp).toBe('string');
  });

  it('returns status degraded when db throws', async () => {
    const { db } = await import('@emapp/db');
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('connection refused'));

    const result = await controller.getHealth();
    expect(result.status).toBe('degraded');
    expect(result.db).toBe('disconnected');
  });
});
