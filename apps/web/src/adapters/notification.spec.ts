/**
 * Phase 4c S3 — pin the Wire → ViewModel adapter for Notification.
 *
 * Test IDs (D.33 mapping):
 *   T-4c-S3-VM.1  exhaustive NotificationType coverage (HE + EN)
 *   T-4c-S3-VM.2  isRead derived from readAt
 *   T-4c-S3-VM.3  link narrowing — relative path passes through
 *   T-4c-S3-VM.4  link narrowing — protocol-relative `//evil.com` rejected
 *   T-4c-S3-VM.5  link narrowing — absolute `https://evil.com` rejected
 *   T-4c-S3-VM.6  link narrowing — empty string → null
 *   T-4c-S3-VM.7  HE/EN locale switching
 *   T-4c-S3-VM.8  body null passes through
 */
import { NotificationSchema, NotificationTypeEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_TYPE_LABELS_EN,
  NOTIFICATION_TYPE_LABELS_HE,
  toNotificationViewModel,
} from './notification';

function baseNotification(over: Partial<import('@emapp/shared-types').Notification> = {}) {
  return NotificationSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    type: 'task_assigned',
    title: 'נקבעה לך משימה חדשה',
    body: 'בנייה 5 — חתימת ראובן כהן',
    link: '/tasks/abc',
    metadata: {},
    readAt: null,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    ...over,
  });
}

describe('toNotificationViewModel — exhaustive type coverage', () => {
  it('T-4c-S3-VM.1) HE + EN labels cover every NotificationType (no drift)', () => {
    const enumKeys = [...NotificationTypeEnum.options].sort();
    expect(Object.keys(NOTIFICATION_TYPE_LABELS_HE).sort()).toEqual(enumKeys);
    expect(Object.keys(NOTIFICATION_TYPE_LABELS_EN).sort()).toEqual(enumKeys);
  });

  it('T-4c-S3-VM.1b) every type produces a non-empty label in HE + EN', () => {
    for (const type of NotificationTypeEnum.options) {
      expect(
        toNotificationViewModel(baseNotification({ type }), 'he').typeLabel.length,
      ).toBeGreaterThan(0);
      expect(
        toNotificationViewModel(baseNotification({ type }), 'en').typeLabel.length,
      ).toBeGreaterThan(0);
    }
  });
});

describe('toNotificationViewModel — isRead derivation', () => {
  it('T-4c-S3-VM.2) readAt=null → isRead=false', () => {
    expect(toNotificationViewModel(baseNotification({ readAt: null })).isRead).toBe(false);
  });

  it('T-4c-S3-VM.2b) readAt set → isRead=true', () => {
    expect(
      toNotificationViewModel(baseNotification({ readAt: new Date('2026-05-22T10:00:00Z') }))
        .isRead,
    ).toBe(true);
  });
});

describe('toNotificationViewModel — link narrowing (open-redirect defense)', () => {
  it('T-4c-S3-VM.3) relative path `/tasks/abc` passes through verbatim', () => {
    expect(toNotificationViewModel(baseNotification({ link: '/tasks/abc' })).link).toBe(
      '/tasks/abc',
    );
  });

  it('T-4c-S3-VM.4) protocol-relative `//evil.com/x` is rejected → null', () => {
    expect(toNotificationViewModel(baseNotification({ link: '//evil.com/x' })).link).toBe(null);
  });

  it('T-4c-S3-VM.5) absolute `https://evil.com/x` is rejected → null', () => {
    expect(toNotificationViewModel(baseNotification({ link: 'https://evil.com/x' })).link).toBe(
      null,
    );
  });

  it('T-4c-S3-VM.5b) javascript: scheme is rejected → null', () => {
    expect(toNotificationViewModel(baseNotification({ link: 'javascript:alert(1)' })).link).toBe(
      null,
    );
  });

  it('T-4c-S3-VM.6) empty string and null both map to null', () => {
    expect(toNotificationViewModel(baseNotification({ link: '' })).link).toBe(null);
    expect(toNotificationViewModel(baseNotification({ link: null })).link).toBe(null);
  });
});

describe('toNotificationViewModel — locale + surface', () => {
  it('T-4c-S3-VM.7) HE and EN labels for task_assigned differ', () => {
    expect(toNotificationViewModel(baseNotification(), 'he').typeLabel).toBe('משימה חדשה');
    expect(toNotificationViewModel(baseNotification(), 'en').typeLabel).toBe('New task');
  });

  it('T-4c-S3-VM.8) body null passes through', () => {
    expect(toNotificationViewModel(baseNotification({ body: null })).body).toBe(null);
  });

  it('T-4c-S3-VM.8b) title passes through verbatim', () => {
    expect(toNotificationViewModel(baseNotification({ title: 'X' })).title).toBe('X');
  });
});
