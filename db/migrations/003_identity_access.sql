-- 003: identity, sessions, MFA and the access control model.

CREATE TABLE identity.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants (id),
  email varchar(254) NOT NULL,
  password_hash text NOT NULL,
  full_name varchar(150) NOT NULL,
  status text NOT NULL DEFAULT 'active',
  mfa_secret text,
  mfa_enabled boolean NOT NULL DEFAULT false,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'disabled')),
  CONSTRAINT users_email_shape CHECK (position('@' in email) > 1)
);
CREATE UNIQUE INDEX uq_users_tenant_email ON identity.users (tenant_id, lower(email));
CREATE TRIGGER users_touch BEFORE UPDATE ON identity.users
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- Opaque session tokens are stored as SHA-256 hashes; the raw token never rests
-- in the database.
CREATE TABLE identity.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash char(64) NOT NULL,
  mfa_verified boolean NOT NULL DEFAULT false,
  issued_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip_address inet,
  user_agent text,
  CONSTRAINT sessions_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES identity.users (tenant_id, id),
  CONSTRAINT sessions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT sessions_token_key UNIQUE (token_hash)
);
CREATE INDEX idx_sessions_user ON identity.sessions (tenant_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE identity.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  branch_id uuid,
  department_id uuid,
  user_id uuid,
  employee_number varchar(40) NOT NULL,
  first_name varchar(100) NOT NULL,
  last_name varchar(100) NOT NULL,
  job_title varchar(120),
  employment_type text NOT NULL DEFAULT 'full_time',
  hire_date date,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employees_org_fk FOREIGN KEY (tenant_id, organization_id)
    REFERENCES platform.organizations (tenant_id, id),
  CONSTRAINT employees_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES identity.users (tenant_id, id),
  CONSTRAINT employees_branch_fk FOREIGN KEY (tenant_id, organization_id, branch_id)
    REFERENCES platform.branches (tenant_id, organization_id, id),
  CONSTRAINT employees_department_fk FOREIGN KEY (tenant_id, department_id)
    REFERENCES platform.departments (tenant_id, id),
  CONSTRAINT employees_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT employees_number_key UNIQUE (tenant_id, organization_id, employee_number),
  CONSTRAINT employees_user_unique UNIQUE (tenant_id, user_id),
  CONSTRAINT employees_status_check CHECK (status IN ('active', 'on_leave', 'terminated'))
);
CREATE TRIGGER employees_touch BEFORE UPDATE ON identity.employees
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- Global permission catalogue (not tenant scoped).
CREATE TABLE access.permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_code varchar(150) NOT NULL,
  product_code varchar(50),
  module_code varchar(80),
  resource varchar(120) NOT NULL,
  action varchar(60) NOT NULL,
  description text,
  is_privileged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_code_key UNIQUE (permission_code),
  CONSTRAINT permissions_code_shape CHECK (permission_code ~ '^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$')
);

CREATE TABLE access.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  role_code varchar(80) NOT NULL,
  role_name varchar(150) NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT roles_code_key UNIQUE (tenant_id, role_code)
);
CREATE TRIGGER roles_touch BEFORE UPDATE ON access.roles
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

CREATE TABLE access.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permissions_role_fk FOREIGN KEY (tenant_id, role_id)
    REFERENCES access.roles (tenant_id, id),
  CONSTRAINT role_permissions_permission_fk FOREIGN KEY (permission_id)
    REFERENCES access.permissions (id),
  CONSTRAINT role_permissions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT role_permissions_unique UNIQUE (tenant_id, role_id, permission_id)
);

CREATE TABLE access.user_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  branch_id uuid,
  department_id uuid,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_roles_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES identity.users (tenant_id, id),
  CONSTRAINT user_roles_role_fk FOREIGN KEY (tenant_id, role_id)
    REFERENCES access.roles (tenant_id, id),
  CONSTRAINT user_roles_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT user_roles_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT user_roles_period_check CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE INDEX idx_user_roles_user ON access.user_role_assignments (tenant_id, user_id);

CREATE TABLE access.user_branch_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_branch_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES identity.users (tenant_id, id),
  CONSTRAINT user_branch_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES platform.branches (tenant_id, id),
  CONSTRAINT user_branch_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT user_branch_unique UNIQUE (tenant_id, user_id, branch_id)
);

-- Amount ceilings per permission, used by separation-of-duties checks.
CREATE TABLE access.approval_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  branch_id uuid,
  permission_code varchar(150) NOT NULL,
  max_amount numeric(18,4) NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'NGN',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_limits_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES identity.users (tenant_id, id),
  CONSTRAINT approval_limits_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT approval_limits_unique UNIQUE (tenant_id, user_id, branch_id, permission_code),
  CONSTRAINT approval_limits_amount_check CHECK (max_amount >= 0)
);
