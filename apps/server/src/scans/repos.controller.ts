import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { listDependenciesQuerySchema, listReposQuerySchema, listScanRunsQuerySchema, repoBulkUpdateSchema, repoUpdateSchema } from '@argus/shared';
import { type Request, type Response } from 'express';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { ReposService } from './repos.service';
import { ScansService } from './scans.service';

@Controller('repos')
export class ReposController {
  constructor(
    private readonly repos: ReposService,
    private readonly scans: ScansService,
  ) {}

  @Get()
  @RequirePermissions('repos:read')
  list(@Query(new ZodPipe(listReposQuerySchema)) q: z.infer<typeof listReposQuerySchema>, @CurrentUser() me: RequestUser) {
    return this.repos.list(q, me.user);
  }

  @Post('bulk')
  @HttpCode(200)
  @RequirePermissions('repos:manage')
  bulk(@Body(new ZodPipe(repoBulkUpdateSchema)) body: z.infer<typeof repoBulkUpdateSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.repos.bulkUpdate(body, me.user, requestContext(req));
  }

  @Get(':id')
  @RequirePermissions('repos:read')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    return this.repos.get(id, me.user);
  }

  @Patch(':id')
  @RequirePermissions('repos:manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(repoUpdateSchema)) body: z.infer<typeof repoUpdateSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.repos.update(id, body, me.user, requestContext(req));
  }

  @Post(':id/scans')
  @HttpCode(202)
  @RequirePermissions('scans:run')
  scanNow(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.repos.scanNow(id, me.user, requestContext(req));
  }

  @Get(':id/dependencies')
  @RequirePermissions('repos:read')
  dependencies(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(listDependenciesQuerySchema)) q: z.infer<typeof listDependenciesQuerySchema>, @CurrentUser() me: RequestUser) {
    return this.repos.dependencies(id, q, me.user);
  }

  /** CycloneDX 1.5 SBOM of the latest scan. */
  @Get(':id/sbom')
  @RequirePermissions('repos:read')
  async sbom(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { fileName, document } = await this.repos.sbom(id, me.user, requestContext(req));
    res.setHeader('Content-Type', 'application/vnd.cyclonedx+json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return document;
  }

  @Get(':id/scans')
  @RequirePermissions('repos:read')
  async scansFor(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(listScanRunsQuerySchema.omit({ repoId: true }))) q: Omit<z.infer<typeof listScanRunsQuerySchema>, 'repoId'>,
    @CurrentUser() me: RequestUser,
  ) {
    await this.repos.require(id, me.user);
    return this.scans.list({ ...q, repoId: id }, me.user);
  }
}

@Controller('scans')
export class ScansController {
  constructor(private readonly scans: ScansService) {}

  @Get()
  @RequirePermissions('repos:read')
  list(@Query(new ZodPipe(listScanRunsQuerySchema)) q: z.infer<typeof listScanRunsQuerySchema>, @CurrentUser() me: RequestUser) {
    return this.scans.list(q, me.user);
  }

  @Get(':id')
  @RequirePermissions('repos:read')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    return this.scans.get(id, me.user);
  }
}
