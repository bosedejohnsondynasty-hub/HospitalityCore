import { api, type Row } from '../api.js';
import { Badge, Button, Card, Notice, useAction, useAsync } from '../components.js';

export function LicensingPage() {
  const catalogue = useAsync(() => api<{ products: Row[] }>('GET', '/api/v1/licensing/catalogue'), []);
  const action = useAction();

  async function toggle(productCode: string, moduleCode: string, licensed: boolean) {
    const ok = await action.run(
      () =>
        api('POST', `/api/v1/licensing/modules/${moduleCode}/${licensed ? 'deactivate' : 'activate'}`, {
          product: productCode,
        }),
      licensed ? `${moduleCode} deactivated` : `${moduleCode} activated`,
    );
    if (ok) catalogue.reload();
  }

  const products = catalogue.data?.products ?? [];
  const totalModules = products.reduce((sum, product) => sum + (product.modules?.length ?? 0), 0);
  const licensedModules = products.reduce(
    (sum, product) => sum + (product.modules ?? []).filter((module: Row) => module.licensed).length,
    0,
  );

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <Notice error={action.error} notice={action.notice} />
      <Card
        title="Module and licence management centre"
        subtitle={`${licensedModules} of ${totalModules} modules licensed across ${products.length} products`}
      >
        <p className="subtle">
          Unlicensed modules stay visible in the catalogue but every API route they gate returns a locked response.
          Deactivation is enforced in the backend, not by hiding buttons.
        </p>
      </Card>

      {products.map((product) => {
        const modules: Row[] = product.modules ?? [];
        return (
          <Card
            key={product.code}
            title={product.product_name ?? product.name ?? product.code}
            subtitle={`${product.code} · ${modules.filter((module) => module.licensed).length}/${modules.length} licensed`}
          >
            <div className="grid grid-3">
              {modules.map((module) => (
                <div
                  key={module.id ?? module.module_code}
                  className="card"
                  style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <strong style={{ fontSize: '0.88rem' }}>{module.module_name ?? module.module_code}</strong>
                    <Badge tone={module.licensed ? 'ok' : 'neutral'}>
                      {module.licensed ? 'licensed' : 'locked'}
                    </Badge>
                  </div>
                  <span className="subtle">{module.category ?? module.module_code}</span>
                  <div style={{ marginTop: 'auto' }}>
                    <Button
                      size="sm"
                      variant={module.licensed ? 'danger' : 'ghost'}
                      onClick={() => toggle(product.code, module.module_code, Boolean(module.licensed))}
                      disabled={action.busy}
                    >
                      {module.licensed ? 'Deactivate' : 'Activate'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
