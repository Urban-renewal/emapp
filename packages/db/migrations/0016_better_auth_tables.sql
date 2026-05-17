-- Better Auth infrastructure tables (auth-scoped, no RLS, ba_ prefix)
-- These tables are managed by Better Auth; EMAPP domain tables remain separate.

CREATE TABLE IF NOT EXISTS "ba_user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL
);

CREATE TABLE IF NOT EXISTS "ba_session" (
  "id" text PRIMARY KEY,
  "expires_at" timestamp NOT NULL,
  "token" text NOT NULL UNIQUE,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "ba_user"("id") ON DELETE CASCADE,
  "active_organization_id" text
);

CREATE TABLE IF NOT EXISTS "ba_account" (
  "id" text PRIMARY KEY,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "ba_user"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp,
  "refresh_token_expires_at" timestamp,
  "scope" text,
  "password" text,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL
);

CREATE TABLE IF NOT EXISTS "ba_verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp,
  "updated_at" timestamp
);

CREATE TABLE IF NOT EXISTS "ba_organization" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "slug" text UNIQUE,
  "logo" text,
  "created_at" timestamp NOT NULL,
  "metadata" text
);

CREATE TABLE IF NOT EXISTS "ba_member" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "ba_organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "ba_user"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "created_at" timestamp NOT NULL
);

CREATE TABLE IF NOT EXISTS "ba_invitation" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "ba_organization"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text,
  "status" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "inviter_id" text NOT NULL REFERENCES "ba_user"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_ba_session_user_id" ON "ba_session"("user_id");
CREATE INDEX IF NOT EXISTS "idx_ba_session_token" ON "ba_session"("token");
CREATE INDEX IF NOT EXISTS "idx_ba_account_user_id" ON "ba_account"("user_id");
CREATE INDEX IF NOT EXISTS "idx_ba_member_org" ON "ba_member"("organization_id");
CREATE INDEX IF NOT EXISTS "idx_ba_member_user" ON "ba_member"("user_id");
