import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler, type Me } from './api.js';
import { LoginPage } from './pages/Login.js';
import { DashboardPage } from './pages/Dashboard.js';
import { HotelPage } from './pages/Hotel.js';
import { RestaurantPage } from './pages/Restaurant.js';
import { BarPage } from './pages/Bar.js';
import { FinancePage } from './pages/Finance.js';
import { LicensingPage } from './pages/Licensing.js';
import { AdminPage } from './pages/Admin.js';
import { InventoryPage } from './pages/Inventory.js';
import { PublicMenuPage } from './pages/PublicMenu.js';
import { WorkforcePage } from './pages/Workforce.js';
import { AssetsPage } from './pages/Assets.js';
import { OperationsPage } from './pages/Operations.js';

type PageKey =
  | 'dashboard'
  | 'hotel'
  | 'restaurant'
  | 'bar'
  | 'inventory'
  | 'workforce'
  | 'assets'
  | 'operations'
  | 'finance'
  | 'licensing'
  | 'admin';

const NAV: Array<{ key: PageKey; label: string; icon: string; module?: string }> = [
  { key: 'dashboard', label: 'Dashboard', icon: '▦' },
  { key: 'hotel', label: 'Hotel', icon: '▤', module: 'reservations' },
  { key: 'restaurant', label: 'Restaurant', icon: '▣', module: 'ordering' },
  { key: 'bar', label: 'Bar', icon: '◆', module: 'orders' },
  { key: 'inventory', label: 'Inventory', icon: '▥', module: 'inventory' },
  { key: 'workforce', label: 'Workforce', icon: '☍', module: 'hr' },
  { key: 'assets', label: 'Fixed assets', icon: '⌂', module: 'fixed_assets' },
  { key: 'operations', label: 'Business tools', icon: '⌗' },
  { key: 'finance', label: 'Finance', icon: '≡' },
  { key: 'licensing', label: 'Licence centre', icon: '⚿' },
  { key: 'admin', label: 'Administration', icon: '⚙' },
];

function parseHash(): { page: PageKey; qrToken: string | null } {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('qr/')) return { page: 'dashboard', qrToken: hash.slice(3) };
  const page = NAV.find((item) => item.key === hash)?.key ?? 'dashboard';
  return { page, qrToken: null };
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      return;
    }
    try {
      setMe(await api<Me>('GET', '/api/v1/auth/me'));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    void refresh();
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  const signOut = async () => {
    try {
      await api('POST', '/api/v1/auth/logout');
    } catch {
      // A failed logout must still clear the local session.
    }
    setToken(null);
    setMe(null);
  };

  if (route.qrToken) return <PublicMenuPage token={route.qrToken} />;
  if (me === undefined) return <div className="empty" style={{ padding: '3rem' }}>Starting Hospitality Core…</div>;
  if (!me) return <LoginPage onSignedIn={setMe} />;

  const licensed = new Set(me.licensedModules);
  const go = (page: PageKey) => {
    window.location.hash = `#/${page}`;
  };
  const active = route.page;
  const locked = (key: PageKey) => {
    const nav = NAV.find((item) => item.key === key);
    return Boolean(nav?.module && !licensed.has(nav.module!));
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">H</span>
          <span>
            <span className="brand-name">Hospitality Core</span>
            <span className="brand-sub">{me.tenant.tenant_name}</span>
          </span>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-item ${active === item.key ? 'active' : ''}`}
              disabled={locked(item.key)}
              title={locked(item.key) ? 'Module not licensed' : item.label}
              onClick={() => go(item.key)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
              {locked(item.key) && <span className="nav-lock">locked</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {me.tenant.tenant_code} · {me.tenant.default_currency} · {me.tenant.timezone}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="grow">
            <h1>{NAV.find((item) => item.key === active)?.label ?? 'Hospitality Core'}</h1>
          </div>
          <div className="who">
            <strong>{me.user.fullName}</strong>
            <span className="subtle">{me.user.roles.join(', ')}</span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={signOut}>
            Sign out
          </button>
        </header>
        <main className="content">
          {active === 'dashboard' && <DashboardPage />}
          {active === 'hotel' && <HotelPage />}
          {active === 'restaurant' && <RestaurantPage />}
          {active === 'bar' && <BarPage />}
          {active === 'inventory' && <InventoryPage />}
          {active === 'workforce' && <WorkforcePage timeZone={me.tenant.timezone} />}
          {active === 'assets' && <AssetsPage />}
          {active === 'operations' && <OperationsPage />}
          {active === 'finance' && <FinancePage />}
          {active === 'licensing' && <LicensingPage />}
          {active === 'admin' && <AdminPage />}
        </main>
      </div>
    </div>
  );
}
