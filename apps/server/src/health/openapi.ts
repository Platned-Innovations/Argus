import { Controller, Get, Injectable } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { DiscoveryService } from '@nestjs/core';
import { z } from 'zod';
import { type Permission } from '@argus/shared';
import { PERMISSIONS_KEY, Public, PUBLIC_KEY, SESSION_ONLY_KEY } from '../auth/decorators';
import { AppConfig } from '../config/app-config';
import { ZodPipe } from '../common/zod.pipe';

type JsonSchema = Record<string, unknown>;

interface RouteArg {
  index: number;
  data?: string;
  pipes?: unknown[];
}

const PREFIX = '/api/v1';
/** Routes outside the global prefix (see app.factory.ts). */
const UNPREFIXED = new Set(['/healthz', '/readyz', '/metrics']);

function toSchema(schema: z.ZodType): JsonSchema {
  try {
    const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
    return rest;
  } catch {
    return {};
  }
}

function joinPath(...parts: (string | undefined)[]): string {
  const p = `/${parts
    .flatMap((x) => (x ?? '').split('/'))
    .filter(Boolean)
    .join('/')}`;
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

const meta = <T>(key: string, ...targets: object[]): T | undefined => {
  for (const t of targets) {
    const v = Reflect.getMetadata(key, t) as T | undefined;
    if (v !== undefined) return v;
  }
  return undefined;
};

/**
 * Builds an OpenAPI 3.1 document from the application's own route metadata: paths and methods from the controllers,
 * request bodies and query parameters from the zod schemas that validate them, and the permissions each route needs.
 * Response bodies are described in prose only (they are TypeScript interfaces, not runtime schemas).
 */
@Injectable()
export class OpenApiService {
  private doc: JsonSchema | null = null;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly config: AppConfig,
  ) {}

  document(): JsonSchema {
    return (this.doc ??= this.build());
  }

  private build(): JsonSchema {
    const paths: Record<string, Record<string, JsonSchema>> = {};
    for (const wrapper of this.discovery.getControllers()) {
      const ctrl = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!ctrl) continue;
      const base = meta<string | string[]>(PATH_METADATA, ctrl);
      const proto = ctrl.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = meta<RequestMethod>(METHOD_METADATA, handler);
        if (method === undefined) continue;
        const sub = meta<string | string[]>(PATH_METADATA, handler);
        const raw = joinPath(Array.isArray(base) ? base[0] : base, Array.isArray(sub) ? sub[0] : sub);
        const path = UNPREFIXED.has(raw) ? raw : `${PREFIX}${raw === '/' ? '' : raw}`;
        const isPublic = meta<boolean>(PUBLIC_KEY, handler, ctrl) === true;
        const sessionOnly = meta<boolean>(SESSION_ONLY_KEY, handler, ctrl) === true;
        const permissions = meta<Permission[]>(PERMISSIONS_KEY, handler, ctrl) ?? [];

        const op: JsonSchema = {
          operationId: `${ctrl.name.replace(/Controller$/, '')}_${name}`,
          tags: [path.replace(PREFIX, '').split('/')[1] || 'root'],
          responses: { default: { description: 'JSON response. Errors use { statusCode, message, code?, issues? }.' } },
        };
        const notes: string[] = [];
        if (permissions.length) notes.push(`Requires: ${permissions.join(', ')}.`);
        if (sessionOnly) notes.push('Browser sessions only; API tokens are refused.');
        else if (!isPublic && !permissions.length) notes.push('Any signed-in user (not available to API tokens).');
        if (notes.length) op.description = notes.join(' ');
        if (permissions.length) op['x-argus-permissions'] = permissions;
        op.security = isPublic ? [] : sessionOnly || !permissions.length ? [{ session: [] }] : [{ session: [] }, { apiToken: [] }];

        const parameters: JsonSchema[] = [...raw.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, name) ?? {}) as Record<string, RouteArg>;
        for (const [key, arg] of Object.entries(args)) {
          const type = Number(key.split(':')[0]);
          const zodPipe = (arg.pipes ?? []).find((p): p is ZodPipe<z.ZodType> => p instanceof ZodPipe);
          if (!zodPipe) continue;
          const schema = toSchema(zodPipe.schema);
          if (type === RouteParamtypes.BODY) op.requestBody = { required: true, content: { 'application/json': { schema } } };
          if (type === RouteParamtypes.QUERY) {
            const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
            const required = new Set((schema.required as string[] | undefined) ?? []);
            for (const [p, s] of Object.entries(props)) parameters.push({ name: p, in: 'query', required: required.has(p) && s.default === undefined, schema: s });
          }
        }
        if (parameters.length) op.parameters = parameters;
        (paths[path] ??= {})[RequestMethod[method].toLowerCase()] = op;
      }
    }
    return {
      openapi: '3.1.0',
      info: {
        title: 'Argus API',
        version: this.config.version,
        description:
          'REST API of Argus. Authenticate with a personal API token (Authorization: Bearer argus_pat_…), created under Profile → API tokens. A token can only call endpoints that declare permissions, within its scopes and its owner’s role.',
      },
      servers: [{ url: this.config.publicUrl ?? '/' }],
      components: {
        securitySchemes: {
          apiToken: { type: 'http', scheme: 'bearer', description: 'Personal API token (argus_pat_…).' },
          session: { type: 'apiKey', in: 'cookie', name: 'argus_at', description: 'Browser session (with the x-csrf-token header on state-changing requests).' },
        },
      },
      paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    };
  }
}

@Controller()
@Public()
export class OpenApiController {
  constructor(private readonly openapi: OpenApiService) {}

  /** The API description, generated from the running code. */
  @Get('openapi.json')
  document() {
    return this.openapi.document();
  }
}
