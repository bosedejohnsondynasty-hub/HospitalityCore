import { useState } from 'react';
import { api, formatDateTime, type Row } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Field,
  FormRow,
  Input,
  Notice,
  Table,
  useAction,
  useAsync,
} from '../components.js';

export function AdminPage() {
  const users = useAsync(() => api<{ users: Row[] }>('GET', '/api/v1/platform/users'), []);
  const roles = useAsync(() => api<{ roles: Row[] }>('GET', '/api/v1/platform/roles'), []);
  const audit = useAsync(() => api<{ events: Row[] }>('GET', '/api/v1/platform/audit?limit=100'), []);
  const action = useAction();

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);

  async function createUser() {
    const ok = await action.run(
      () =>
        api('POST', '/api/v1/platform/users', {
          email,
          fullName,
          password,
          roles: selectedRoles.length ? selectedRoles : ['front_desk'],
        }),
      'User created',
    );
    if (ok) {
      setEmail('');
      setFullName('');
      setPassword('');
      setSelectedRoles([]);
      users.reload();
    }
  }

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />
      <Card title="Create user" subtitle="Roles are resolved against the seeded permission templates">
        <FormRow>
          <Field label="Email"><Input value={email} onChange={setEmail} type="email" /></Field>
          <Field label="Full name"><Input value={fullName} onChange={setFullName} /></Field>
          <Field label="Password" hint="12+ characters with a letter and a number.">
            <Input value={password} onChange={setPassword} type="password" />
          </Field>
          <Button onClick={createUser} disabled={action.busy || !email || !fullName || !password}>
            Create user
          </Button>
        </FormRow>
        <div className="form-row" style={{ marginTop: '0.8rem' }}>
          {(roles.data?.roles ?? []).map((role) => (
            <label className="checkbox" key={role.id}>
              <input
                type="checkbox"
                checked={selectedRoles.includes(role.role_code)}
                onChange={(event) =>
                  setSelectedRoles(
                    event.target.checked
                      ? [...selectedRoles, role.role_code]
                      : selectedRoles.filter((code) => code !== role.role_code),
                  )
                }
              />
              {role.role_name}
            </label>
          ))}
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="Users">
          <Table
            rows={users.data?.users}
            loading={users.loading}
            columns={[
              { key: 'full_name', header: 'Name' },
              { key: 'email', header: 'Email' },
              {
                key: 'roles',
                header: 'Roles',
                render: (row) => (Array.isArray(row.roles) ? row.roles.join(', ') : '—'),
              },
              {
                key: 'status',
                header: 'Status',
                render: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{row.status}</Badge>,
              },
              {
                key: 'last_login_at',
                header: 'Last sign-in',
                render: (row) => (row.last_login_at ? formatDateTime(row.last_login_at) : '—'),
              },
            ]}
            empty="No users."
          />
        </Card>

        <Card title="Roles" subtitle="Permission counts come from the seeded templates">
          <Table
            rows={roles.data?.roles}
            loading={roles.loading}
            columns={[
              { key: 'role_name', header: 'Role' },
              { key: 'role_code', header: 'Code' },
              { key: 'permission_count', header: 'Permissions', align: 'right' },
            ]}
          />
        </Card>
      </div>

      <Card title="Audit trail" subtitle="Append-only events, newest first">
        <Table
          rows={audit.data?.events}
          loading={audit.loading}
          columns={[
            { key: 'created_at', header: 'When', render: (row) => formatDateTime(row.created_at) },
            { key: 'actor_label', header: 'Actor', render: (row) => row.actor_label ?? 'system' },
            { key: 'action', header: 'Action' },
            { key: 'entity_type', header: 'Entity' },
            { key: 'entity_id', header: 'Entity id', render: (row) => String(row.entity_id ?? '—').slice(0, 8) },
          ]}
          empty="No audit events yet."
        />
      </Card>
    </div>
  );
}
