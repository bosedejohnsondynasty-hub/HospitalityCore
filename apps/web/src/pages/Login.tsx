import { useEffect, useState } from 'react';
import { api, setToken, type Me, type Row } from '../api.js';
import { Button, Field, FormRow, Input, Notice } from '../components.js';

interface SetupStatus {
  provisioned: boolean;
  apiSetupEnabled: boolean;
}

export function LoginPage({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [mode, setMode] = useState<'login' | 'setup'>('login');
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantCode, setTenantCode] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  const [setupToken, setSetupToken] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [tenant, setTenant] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [currency, setCurrency] = useState('NGN');
  const [products, setProducts] = useState({ hotel: true, restaurant: true, bar: true });

  useEffect(() => {
    api<SetupStatus>('GET', '/api/v1/setup/status')
      .then((result) => {
        setStatus(result);
        if (!result.provisioned && result.apiSetupEnabled) setMode('setup');
      })
      .catch(() => setStatus(null));
  }, []);

  async function finishLogin(loginEmail: string, loginPassword: string) {
    const result = await api<{ token: string }>('POST', '/api/v1/auth/login', {
      email: loginEmail,
      password: loginPassword,
      ...(tenantCode ? { tenantCode } : {}),
      ...(mfaCode ? { mfaCode } : {}),
    });
    setToken(result.token);
    onSignedIn(await api<Me>('GET', '/api/v1/auth/me'));
  }

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await finishLogin(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  async function submitSetup(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const selected = Object.entries(products)
      .filter(([, enabled]) => enabled)
      .map(([code]) => code);
    if (selected.length === 0) {
      setError('Select at least one product to license.');
      setBusy(false);
      return;
    }
    try {
      const payload: Row = {
        tenantCode: tenant,
        tenantName,
        adminEmail,
        adminName,
        adminPassword,
        defaultCurrency: currency,
        products: selected,
        branches: selected.map((code) => ({
          code: code.toUpperCase().slice(0, 6),
          name: `${tenantName} ${code}`,
          type: code,
        })),
      };
      if (products.hotel) {
        payload.hotel = {
          code: tenant.toUpperCase().slice(0, 6),
          name: `${tenantName} Hotel`,
          roomTypes: [
            { code: 'STD', name: 'Standard Room', baseRate: 50000, rooms: ['101', '102', '103'] },
            { code: 'DLX', name: 'Deluxe Room', baseRate: 85000, rooms: ['201', '202'] },
          ],
        };
      }
      if (products.restaurant) {
        payload.restaurant = {
          code: 'REST',
          name: `${tenantName} Restaurant`,
          tables: [
            { code: 'T1', seats: 4 },
            { code: 'T2', seats: 4 },
            { code: 'T3', seats: 2 },
          ],
          stations: [
            { code: 'HOT', name: 'Hot Kitchen' },
            { code: 'GRILL', name: 'Grill' },
            { code: 'BAR', name: 'Bar Station' },
          ],
        };
      }
      if (products.bar) payload.bar = { code: 'BAR01', name: `${tenantName} Bar` };

      await api('POST', '/api/v1/setup/bootstrap', payload, { 'x-setup-token': setupToken });
      await finishLogin(adminEmail, adminPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Provisioning failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <section className="auth-hero">
        <div>
          <div className="brand" style={{ padding: 0 }}>
            <span className="brand-mark">H</span>
            <span>
              <span className="brand-name">Hospitality Core</span>
              <span className="brand-sub">Hotel · Restaurant · Bar</span>
            </span>
          </div>
          <h1 style={{ marginTop: '2.4rem' }}>One platform. Three independently licensed products.</h1>
          <p>
            Front office, housekeeping, kitchen, bar and finance on a self-hosted PostgreSQL
            core with enforced tenant isolation, append-only ledgers and verified payments.
          </p>
          <div className="auth-points">
            <span>Module licensing centre with locked entitlements</span>
            <span>Double-booking prevented in the database</span>
            <span>Restaurant and bar revenue recognised once</span>
            <span>Paystack and Flutterwave with server-side verification</span>
          </div>
        </div>
        <p>Self-hosted · PostgreSQL 15+ · Offline-tolerant mobile web</p>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <h2>{mode === 'login' ? 'Sign in' : 'First-run setup'}</h2>
          <p className="subtle">
            {mode === 'login'
              ? 'Use the credentials issued by your administrator.'
              : 'Create the tenant, administrator account and initial product licences.'}
          </p>
          <Notice error={error} />

          {mode === 'login' ? (
            <form onSubmit={submitLogin}>
              <Field label="Email">
                <Input value={email} onChange={setEmail} type="email" required placeholder="you@hotel.com" />
              </Field>
              <Field label="Password">
                <Input value={password} onChange={setPassword} type="password" required />
              </Field>
              <Field label="Tenant code" hint="Only needed when the same email exists in several tenants.">
                <Input value={tenantCode} onChange={setTenantCode} placeholder="e.g. lagosgrand" />
              </Field>
              <Field label="MFA code" hint="Required when multi-factor authentication is enabled.">
                <Input value={mfaCode} onChange={setMfaCode} placeholder="123456" />
              </Field>
              <Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
            </form>
          ) : (
            <form onSubmit={submitSetup}>
              <Field label="Setup token" hint="The SETUP_TOKEN configured on the server.">
                <Input value={setupToken} onChange={setSetupToken} type="password" required />
              </Field>
              <FormRow>
                <Field label="Tenant name">
                  <Input value={tenantName} onChange={setTenantName} required placeholder="Lagos Grand Hotels" />
                </Field>
                <Field label="Tenant code" hint="Lowercase, no spaces.">
                  <Input value={tenant} onChange={setTenant} required placeholder="lagosgrand" />
                </Field>
              </FormRow>
              <FormRow>
                <Field label="Administrator name">
                  <Input value={adminName} onChange={setAdminName} required />
                </Field>
                <Field label="Currency">
                  <Input value={currency} onChange={setCurrency} required />
                </Field>
              </FormRow>
              <Field label="Administrator email">
                <Input value={adminEmail} onChange={setAdminEmail} type="email" required />
              </Field>
              <Field label="Administrator password" hint="At least 12 characters with a letter and a number.">
                <Input value={adminPassword} onChange={setAdminPassword} type="password" required />
              </Field>
              <div className="form-row">
                {(['hotel', 'restaurant', 'bar'] as const).map((code) => (
                  <label className="checkbox" key={code}>
                    <input
                      type="checkbox"
                      checked={products[code]}
                      onChange={(event) => setProducts({ ...products, [code]: event.target.checked })}
                    />
                    {code[0]!.toUpperCase() + code.slice(1)}
                  </label>
                ))}
              </div>
              <Button type="submit" disabled={busy}>
                {busy ? 'Provisioning…' : 'Create installation'}
              </Button>
            </form>
          )}

          {status && !status.provisioned && status.apiSetupEnabled && (
            <button type="button" className="auth-toggle" onClick={() => setMode(mode === 'login' ? 'setup' : 'login')}>
              {mode === 'login' ? 'First run? Provision this installation' : 'Back to sign in'}
            </button>
          )}
          {status && !status.apiSetupEnabled && !status.provisioned && (
            <p className="subtle">
              This installation has no tenant yet and API setup is disabled. Run the provisioning command on the
              server (see INSTALL.md).
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
