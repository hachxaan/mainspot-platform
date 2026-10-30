/**
 * Proceso propio del scheduler de publicaciones sociales (DEV-E2E-04, P4).
 *
 *   SOCIAL_SCHEDULER=off node src/api/server.ts      # servidor HTTP sin scheduler
 *   node scripts/social-scheduler.ts [--once]         # scheduler independiente del navegador
 *
 * Varios procesos pueden convivir: cada fila de scheduled_post se reclama con lease
 * (FOR UPDATE SKIP LOCKED), así que dos schedulers nunca publican la misma fila. `--once`
 * ejecuta un ciclo y termina (útil en pruebas y para reconciliar a mano).
 */

import { createApp } from '../src/api/server.ts';
import { log } from '../src/shared/logger.ts';

async function main(): Promise<void> {
  const { socialScheduler, config, pool } = createApp();
  if (process.argv.includes('--once')) {
    const report = await socialScheduler.tick();
    console.log(JSON.stringify({ ...report, publishedPosts: report.publishedPosts.map((p) => p.post_id) }, null, 2));
    await pool.end();
    return;
  }
  socialScheduler.start(config.socialSchedulerIntervalMs);
  log.info('social.scheduler.process', 'standalone social scheduler started', { interval_ms: config.socialSchedulerIntervalMs, timezone: config.socialSchedulerTimezone });
  const keepAlive = setInterval(() => undefined, 1 << 30);
  const stop = (signal: string) => {
    log.info('social.scheduler.stopping', `received ${signal}`, {});
    socialScheduler.stop();
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
