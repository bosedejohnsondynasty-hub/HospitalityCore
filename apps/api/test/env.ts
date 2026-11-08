// Test environment must be configured before any module reads config.ts.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://hospitality_app:hc_local_app_password@127.0.0.1:5432/hospitality_core';
process.env.DATABASE_ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/hospitality_core';
process.env.APP_DB_USER = 'hospitality_app';
process.env.APP_DB_PASSWORD = 'hc_local_app_password';
process.env.REQUIRE_RESTRICTED_DB_ROLE = 'true';
process.env.ALLOW_API_SETUP = 'true';
process.env.SETUP_TOKEN = 'test-setup-token';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_paystack_secret_for_tests';
process.env.FLUTTERWAVE_SECRET_HASH = 'flutterwave-test-hash';
process.env.PAYMENTS_ALLOW_OFFLINE_VERIFY = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.CORS_ORIGINS = 'http://localhost:3000';
