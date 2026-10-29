import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AUTH_RATE_LIMIT_SETTING } from './auth/auth.controller';
import { type AppConfig } from './config/app-config';

/** Errors raised by body-parser (http-errors with a `type` such as entity.parse.failed or entity.too.large). */
type BodyParserError = Error & { type?: string; status?: number; expose?: boolean; expected?: number; received?: number };

/** Builds the HTTP application (used by main.ts and the end-to-end tests). */
export async function createApiApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.trustProxy);
  app.set(AUTH_RATE_LIMIT_SETTING, config.authRateLimit);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.cookieSecure ? [] : null,
        },
      },
      strictTransportSecurity: config.cookieSecure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use(cookieParser());
  // Webhook payloads (large pushes) can be several MB and need the raw bytes for signature verification.
  app.use(
    '/api/v1/webhooks',
    json({
      limit: '25mb',
      verify: (req: Request, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(json({ limit: '1mb' }));
  // A body that cannot be read (malformed JSON, too large, cut short) would otherwise surface as "Cannot POST …" (404).
  app.use((err: BodyParserError, req: Request, res: Response, next: NextFunction) => {
    if (!err?.type || !err.status) return next(err);
    app.get(Logger).warn({ type: err.type, method: req.method, path: req.path, expected: err.expected, received: err.received }, `Request body rejected: ${err.message}`);
    res.status(err.status).json({ statusCode: err.status, message: err.expose ? err.message : 'Invalid request body.' });
  });
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();
  return app;
}
