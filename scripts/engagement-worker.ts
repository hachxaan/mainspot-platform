/**
 * Proceso propio del observador del agente de atención (DEV-E2E-02).
 *
 *   ENGAGEMENT_WORKER=off node src/api/server.ts      # servidor HTTP sin observador
 *   node scripts/engagement-worker.ts [--once]        # observador independiente del navegador
 *
 * Varios procesos pueden convivir: cada tenant se procesa con un candado consultivo de
 * PostgreSQL (sin doble procesamiento). `--once` ejecuta un ciclo y termina (útil en pruebas).
 */

import { createApp } from '../src/api/server.ts';
import { log } from '../src/shared/logger.ts';

async function main(): Promise<void> {
  const { engagementWorker, config, pool } = createApp();
  if (process.argv.includes('--once')) {
    const reports = await engagementWorker.tick();
    console.log(JSON.stringify({ tenants: reports.length, reports }, null, 2));
    await pool.end();
    return;
  }
  engagementWorker.start(config.engagementWorkerIntervalMs);
  log.info('engagement.worker.process', 'standalone engagement worker started', { interval_ms: config.engagementWorkerIntervalMs });
  const keepAlive = setInterval(() => undefined, 1 << 30);
  const stop = (signal: string) => {
    log.info('engagement.worker.stopping', `received ${signal}`, {});
    engagementWorker.stop();
    clearInterval(keepAlive);
    void pool.end().finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
