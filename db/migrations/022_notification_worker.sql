-- 022: notification delivery worker support.
--
-- The notification schema (migration 002) was queue-only: nothing queued
-- messages, nothing delivered them. This migration adds delivery bookkeeping
-- (retry attempts with backoff), the worker sweep index and the permission
-- catalogue entries the API and worker enforce. Row level security already
-- covers notification.messages (migration 015); the worker runs per tenant
-- through the API's tenant-scoped connection pool, so it never bypasses RLS.

ALTER TABLE notification.messages
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_messages_due
  ON notification.messages (next_attempt_at)
  WHERE status = 'queued';

INSERT INTO access.permissions (permission_code, product_code, module_code, resource, action, description, is_privileged)
SELECT v.permission_code, v.product_code, v.module_code, v.resource, v.action, v.description, v.is_privileged
FROM (VALUES
  ('hotel.notifications.view', 'hotel', 'notifications', 'messages', 'view', 'View queued and delivered messages.', false),
  ('hotel.notifications.send', 'hotel', 'notifications', 'messages', 'send', 'Queue and deliver guest messages.', false)
) AS v (permission_code, product_code, module_code, resource, action, description, is_privileged)
WHERE NOT EXISTS (
  SELECT 1 FROM access.permissions p WHERE p.permission_code = v.permission_code
);
