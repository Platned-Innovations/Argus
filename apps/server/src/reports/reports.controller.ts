import { Controller, Get, Header, Query, Req, StreamableFile } from '@nestjs/common';
import { dashboardQuerySchema } from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { ReportsService } from './reports.service';

@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Posture, trends, remediation speed and SLA compliance for the organisation, a team or a repository. */
  @Get('dashboard')
  @RequirePermissions('reports:read')
  dashboard(@Query(new ZodPipe(dashboardQuerySchema)) q: z.infer<typeof dashboardQuerySchema>, @CurrentUser() me: RequestUser) {
    return this.reports.dashboard(q, me.user);
  }

  @Get('reports/summary.pdf')
  @RequirePermissions('reports:read')
  async summaryPdf(@Query(new ZodPipe(dashboardQuerySchema)) q: z.infer<typeof dashboardQuerySchema>, @CurrentUser() me: RequestUser, @Req() req: Request): Promise<StreamableFile> {
    const pdf = await this.reports.summaryPdf(q, me.user, requestContext(req));
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `attachment; filename="security-report-${new Date().toISOString().slice(0, 10)}.pdf"` });
  }

  @Get('reports/findings.csv')
  @RequirePermissions('reports:read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="argus-findings.csv"')
  findingsCsv(@Query(new ZodPipe(dashboardQuerySchema)) q: z.infer<typeof dashboardQuerySchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.reports.findingsCsv(q, me.user, requestContext(req));
  }
}
