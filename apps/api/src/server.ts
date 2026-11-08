import { buildApp } from './app.js';
import { config } from './config.js';
import { closePools, verifyDatabaseSecurity } from './db.js';

async function main(): Promise<void> {
  await verifyDatabaseSecurity();
  const app = await buildApp();
  try {
    await app.listen({ port: config.API_PORT, host: config.API_HOST });
    app.log.info(
      `Hospitality Core API listening on ${config.API_HOST}:${config.API_PORT} (${config.NODE_ENV})`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down`);
    await app.close();
    await closePools();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
