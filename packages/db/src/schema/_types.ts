import { customType } from 'drizzle-orm/pg-core';

// BYTEA — for encrypted PII columns (national_id, phone, signature_blob)
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// CITEXT — case-insensitive text, used for emails (requires citext extension)
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

// INET — IP addresses, used in audit_log
export const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'inet';
  },
});
