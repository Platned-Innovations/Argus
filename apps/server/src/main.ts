import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { createApiApp } from './app.factory';
import { WorkerAppModule } from './app.module';
import { AppConfig, ConfigError } from './config/app-config';

async function main(): Promise<void> {
  const config = AppConfig.fromEnv(process.env);

  if (config.role === 'worker') {
    const app = await NestFactory.createApplicationContext(WorkerAppModule.register(config), { bufferLogs: true });
    app.useLogger(app.get(Logger));
    app.enableShutdownHooks();
    await app.init();
    return;
  }

  const app = await createApiApp(config);
  await app.listen(config.port, '0.0.0.0');
  app.get(Logger).log(`Argus ${config.version} (${config.role}) listening on port ${config.port}${config.webDir ? '' : ' (web UI not bundled)'}`);
}

main().catch((err: unknown) => {
  // Configuration errors are user-facing; print them without a stack trace.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
