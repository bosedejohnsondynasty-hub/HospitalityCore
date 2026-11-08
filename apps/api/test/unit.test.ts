import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesPatterns, ROLE_TEMPLATES, DEFAULT_COA } from '../src/catalogue.js';
import {
  hashPassword,
  verifyPassword,
  validatePassword,
  generateTotpSecret,
  totpCode,
  verifyTotp,
} from '../src/security.js';
import { money } from '../src/services/finance.js';

test('permission pattern matching honours allows, wildcards and denials', () => {
  assert.equal(matchesPatterns('hotel.folios.post', ['hotel.folios.*']), true);
  assert.equal(matchesPatterns('hotel.folios.post', ['hotel.folios.view']), false);
  assert.equal(matchesPatterns('hotel.folios.post', ['*.*']), true);
  assert.equal(matchesPatterns('hotel.folios.post', ['*.*.view']), false);
  assert.equal(matchesPatterns('hotel.folios.view', ['*.*.view']), true);
  assert.equal(
    matchesPatterns('inventory.stock.adjust.approve', ['inventory.stock.*']),
    true,
    'trailing wildcard covers deeper action paths',
  );
  assert.equal(
    matchesPatterns('hotel.folios.reverse', ['hotel.folios.*'], ['hotel.folios.reverse']),
    false,
    'denials win over allows',
  );
});

test('every role template resolves against the seeded permission catalogue', async () => {
  const { sql } = await import('./helpers.js');
  const permissions = await sql<{ permission_code: string }>(
    'SELECT permission_code FROM access.permissions',
  );
  assert.ok(permissions.length >= 200, 'permission catalogue should be seeded');
  for (const template of ROLE_TEMPLATES) {
    const matched = permissions.filter((p) =>
      matchesPatterns(p.permission_code, template.allow, template.deny ?? []),
    );
    assert.ok(
      matched.length > 0,
      `role ${template.code} must resolve to at least one permission`,
    );
  }
  const cashier = ROLE_TEMPLATES.find((r) => r.code === 'cashier')!;
  assert.equal(
    permissions.some(
      (p) => p.permission_code === 'restaurant.payments.refund' &&
        matchesPatterns(p.permission_code, cashier.allow, cashier.deny ?? []),
    ),
    false,
    'cashier must not be able to approve refunds',
  );
  const auditor = ROLE_TEMPLATES.find((r) => r.code === 'internal_auditor')!;
  const auditorPerms = permissions.filter((p) =>
    matchesPatterns(p.permission_code, auditor.allow, auditor.deny ?? []),
  );
  assert.ok(
    auditorPerms.every((p) => p.permission_code.endsWith('.view') || p.permission_code === 'platform.audit.view'),
    'auditor must be read only',
  );
});

test('default chart of accounts includes the accounts every posting path uses', () => {
  const codes = DEFAULT_COA.map((a) => a.code);
  for (const required of ['1000', '1100', '4100', '4200', '1200', '2000']) {
    assert.ok(codes.includes(required), `missing account ${required}`);
  }
  const debits = DEFAULT_COA.filter((a) => a.normal === 'debit').map((a) => a.class);
  assert.ok(debits.every((c) => c === 'asset' || c === 'expense'));
});

test('passwords are hashed with a salt and verified safely', () => {
  const hash = hashPassword('CorrectHorse9Battery');
  assert.ok(hash.startsWith('scrypt$'));
  assert.notEqual(hash, hashPassword('CorrectHorse9Battery'), 'salt makes hashes unique');
  assert.equal(verifyPassword('CorrectHorse9Battery', hash), true);
  assert.equal(verifyPassword('wrong-password-1', hash), false);
  assert.throws(() => validatePassword('short1'), /at least/);
  assert.throws(() => validatePassword('alllettersonly'), /letter and one number/);
});

test('TOTP verification accepts the current code and rejects drift beyond one step', () => {
  const secret = generateTotpSecret();
  const now = Date.now();
  const counter = Math.floor(now / 30_000);
  assert.equal(verifyTotp(secret, totpCode(secret, counter), now), true);
  assert.equal(verifyTotp(secret, totpCode(secret, counter - 1), now), true);
  assert.equal(verifyTotp(secret, totpCode(secret, counter - 5), now), false);
  assert.equal(verifyTotp(secret, '000000', now), totpCode(secret, counter) === '000000');
  assert.equal(verifyTotp(secret, 'abc', now), false);
});

test('money helper rounds to four decimal places', () => {
  assert.equal(money(0.1 + 0.2), 0.3);
  assert.equal(money(1.23456), 1.2346);
  assert.equal(money(-0.00001), 0);
});

test.after(async () => {
  const { closeAll } = await import('./helpers.js');
  await closeAll();
});
