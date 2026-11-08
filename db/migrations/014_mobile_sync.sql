-- 014: mobile devices, offline command synchronisation and conflict records.

CREATE TABLE mobile.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  device_id varchar(120) NOT NULL,
  platform text NOT NULL DEFAULT 'android',
  app_version varchar(40),
  push_token text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES identity.users (tenant_id, id),
  CONSTRAINT devices_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT devices_device_key UNIQUE (tenant_id, device_id),
  CONSTRAINT devices_platform_check CHECK (platform IN ('android', 'ios', 'web', 'pwa', 'desktop'))
);

-- Idempotent offline command intake. A command id is processed at most once;
-- replays return the stored result instead of re-executing the effect.
CREATE TABLE mobile.sync_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  user_id uuid NOT NULL,
  command_id varchar(120) NOT NULL,
  command_type varchar(80) NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received',
  result jsonb,
  conflict_reason text,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CONSTRAINT sync_commands_device_fk FOREIGN KEY (tenant_id, device_id)
    REFERENCES mobile.devices (tenant_id, id),
  CONSTRAINT sync_commands_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES identity.users (tenant_id, id),
  CONSTRAINT sync_commands_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT sync_commands_command_key UNIQUE (tenant_id, command_id),
  CONSTRAINT sync_commands_status_check CHECK (status IN ('received', 'applied', 'duplicate', 'rejected', 'conflict'))
);
CREATE INDEX idx_sync_commands_pending ON mobile.sync_commands (tenant_id, status, received_at);

CREATE TABLE mobile.sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  sync_command_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  server_state jsonb,
  client_state jsonb,
  resolution text NOT NULL DEFAULT 'pending',
  resolved_by uuid,
  resolved_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_conflicts_command_fk FOREIGN KEY (tenant_id, sync_command_id)
    REFERENCES mobile.sync_commands (tenant_id, id),
  CONSTRAINT sync_conflicts_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT sync_conflicts_resolution_check CHECK (
    resolution IN ('pending', 'client_wins', 'server_wins', 'merged', 'discarded')
  )
);
