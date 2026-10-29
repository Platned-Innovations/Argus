import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { findingSummaryQuerySchema, listFindingsQuerySchema, packageSearchQuerySchema, suppressionSchema } from '@argus/shared';
import { type Request } from 'express';
import { z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { FindingsService } from './findings.service';

@Controller('findings')
export class FindingsController {
  constructor(private readonly findings: FindingsService) {}

  @Get()
  @RequirePermissions('findings:read')
  list(@Query(new ZodPipe(listFindingsQuerySchema)) q: z.infer<typeof listFindingsQuerySchema>, @CurrentUser() me: RequestUser) {
    return this.findings.list(q, me.user);
  }

  @Get('summary')
  @RequirePermissions('findings:read')
  summary(@Query(new ZodPipe(findingSummaryQuerySchema)) q: z.infer<typeof findingSummaryQuerySchema>, @CurrentUser() me: RequestUser) {
    return this.findings.summary(q.repoId, me.user);
  }

  @Get(':id')
  @RequirePermissions('findings:read')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    return this.findings.get(id, me.user);
  }
}

@Controller('packages')
export class PackagesController {
  constructor(private readonly findings: FindingsService) {}

  /** Which repositories use a package (optionally within a version range)? Key question during an incident. */
  @Get('search')
  @RequirePermissions('repos:read')
  search(@Query(new ZodPipe(packageSearchQuerySchema)) q: z.infer<typeof packageSearchQuerySchema>, @CurrentUser() me: RequestUser) {
    return this.findings.searchPackages(q, me.user);
  }
}

const suppressionListQuery = z.object({ repoId: z.uuid().optional() });

@Controller('suppressions')
export class SuppressionsController {
  constructor(private readonly findings: FindingsService) {}

  @Get()
  @RequirePermissions('findings:read')
  list(@Query(new ZodPipe(suppressionListQuery)) q: z.infer<typeof suppressionListQuery>, @CurrentUser() me: RequestUser) {
    return this.findings.listSuppressions(q.repoId, me.user);
  }

  @Post()
  @RequirePermissions('tickets:triage')
  create(@Body(new ZodPipe(suppressionSchema)) body: z.infer<typeof suppressionSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.findings.createSuppression(body, me.user, requestContext(req));
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('tickets:triage')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.findings.deleteSuppression(id, me.user, requestContext(req));
  }
}
