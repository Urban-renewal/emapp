import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { routeLabel } from './metrics.interceptor';

describe('routeLabel — low-cardinality / no-PII guard', () => {
  it('prefers the Fastify route template when present', () => {
    const req = {
      url: '/api/v1/owners/3f1c9e2a-1111-2222-3333-444455556666',
      routeOptions: { url: '/api/v1/owners/:id' },
    } as unknown as FastifyRequest;
    expect(routeLabel(req)).toBe('/api/v1/owners/:id');
  });

  it('collapses UUID segments to :id in the fallback path', () => {
    const req = {
      url: '/api/v1/owners/3f1c9e2a-1111-2222-3333-444455556666/notes',
    } as unknown as FastifyRequest;
    expect(routeLabel(req)).toBe('/api/v1/owners/:id/notes');
  });

  it('collapses long numeric ids and strips the query string', () => {
    const req = {
      url: '/api/v1/projects/123456?national_id=000000000',
    } as unknown as FastifyRequest;
    const label = routeLabel(req);
    expect(label).toBe('/api/v1/projects/:id');
    // The query string (which could carry PII) is never part of the label.
    expect(label).not.toContain('national_id');
    expect(label).not.toContain('?');
  });
});
