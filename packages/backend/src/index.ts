import { buildApp } from './app.js';
import { env } from './config/env.js';

async function main() {
  const app = await buildApp();
  const protocol = env.TLS_CERT_PATH ? 'https' : 'http';

  // Keep the backend alive on stray async errors (e.g. driver bugs that throw
  // synchronously from a socket event handler and bypass promise catches).
  // Without these, a single bad parameter binding can kill the whole process.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'uncaughtException');
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Server listening on ${protocol}://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
