-- 0075: team messaging — internal member ↔ member conversations
-- (dashboard "Recent conversations" → a real feature; design approved GO).
--
-- Three org-scoped tables: `conversations` (thread envelope, denormalized
-- last_message_at recency key), `conversation_participants` (membership +
-- per-user last_read_at for unread counts), and `messages` (the content).
--
-- AUTHORIZATION = participation-based (record-level), NOT the IAM capability
-- matrix. RLS posture:
--   • conversation_participants → ORG isolation only (non-recursive base).
--   • conversations / messages   → ORG isolation AND participant isolation,
--     the latter via a subquery INTO conversation_participants filtered by the
--     app.user_id GUC. Because that subquery targets a DIFFERENT table whose
--     own policy is org-only, there is NO RLS recursion. This gives the
--     sensitive content (thread existence + message bodies) RLS-level
--     participant isolation — a member physically cannot read a thread they
--     are not in, not merely "the service hides it".
-- Message bodies are member-internal collaboration text (not PII national_id/
-- phone/signatures) — org RLS is the hard isolation boundary, mirroring notes.
--
-- Reversibility: HIGH. DROP TABLE messages, conversation_participants,
-- conversations (CASCADE) restores the prior state. Guarded/idempotent so a
-- concurrent test-worker migrate() is safe.

-- ════════════════════ conversations ═════════════════════════════════════════
CREATE TABLE IF NOT EXISTS conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- NULL for 1:1 DMs; set for named group threads.
  title            text,
  created_by       uuid NOT NULL REFERENCES users(id),
  -- Denormalized recency key (bumped on each message insert) so the thread
  -- list sorts by latest activity without a join/aggregate.
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_conversations_org_recent
  ON conversations (org_id, last_message_at DESC)
  WHERE archived_at IS NULL;

-- ════════════════════ conversation_participants ═════════════════════════════
CREATE TABLE IF NOT EXISTS conversation_participants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Unread = messages with created_at > last_read_at. NULL = never opened.
  last_read_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_participants_conv_user_unique
  ON conversation_participants (conversation_id, user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_user
  ON conversation_participants (user_id);

-- ════════════════════ messages ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        uuid NOT NULL REFERENCES users(id),
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC, id DESC);

-- ════════════════════ RLS ═══════════════════════════════════════════════════
ALTER TABLE conversations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations              FORCE  ROW LEVEL SECURITY;
ALTER TABLE conversation_participants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_participants  FORCE  ROW LEVEL SECURITY;
ALTER TABLE messages                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages                   FORCE  ROW LEVEL SECURITY;

-- conversation_participants: ORG isolation only (the non-recursive base the
-- other two policies subquery into).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'conversation_participants'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON conversation_participants
      USING (org_id = current_setting('app.organization_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- conversations: ORG isolation + participant read-scoping. WITH CHECK is
-- org-only so the CREATOR can INSERT/UPDATE the row before/while participant
-- rows are written in the same tx; the participant USING clause then gates who
-- can READ it back.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'conversations'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON conversations
      USING (
        org_id = current_setting('app.organization_id', true)::uuid
        AND id IN (
          SELECT conversation_id FROM conversation_participants
          WHERE user_id = current_setting('app.user_id', true)::uuid
        )
      )
      WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid);
  END IF;
END;
$$;

-- messages: ORG isolation + participant read AND write scoping. The WITH CHECK
-- participant clause enforces "only a participant may post" at the DB level.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'messages'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON messages
      USING (
        org_id = current_setting('app.organization_id', true)::uuid
        AND conversation_id IN (
          SELECT conversation_id FROM conversation_participants
          WHERE user_id = current_setting('app.user_id', true)::uuid
        )
      )
      WITH CHECK (
        org_id = current_setting('app.organization_id', true)::uuid
        AND conversation_id IN (
          SELECT conversation_id FROM conversation_participants
          WHERE user_id = current_setting('app.user_id', true)::uuid
        )
      );
  END IF;
END;
$$;

-- ════════════════════ grants (no hard DELETE on app_user) ═══════════════════
GRANT SELECT, INSERT, UPDATE ON conversations             TO app_user;
GRANT SELECT, INSERT, UPDATE ON conversation_participants TO app_user;
GRANT SELECT, INSERT, UPDATE ON messages                  TO app_user;
REVOKE DELETE ON conversations             FROM app_user;
REVOKE DELETE ON conversation_participants FROM app_user;
REVOKE DELETE ON messages                  FROM app_user;
