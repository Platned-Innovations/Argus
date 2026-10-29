import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { savedViewCreateSchema, savedViewListQuerySchema } from '@argus/shared';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { SavedViewsService } from './saved-views.service';

/**
 * Saved list views, a browser-only convenience: no permissions are declared, so API tokens cannot use these
 * endpoints. Access to each list is checked in the service.
 */
@Controller('saved-views')
@RequirePermissions()
export class SavedViewsController {
  constructor(private readonly views: SavedViewsService) {}

  @Get()
  list(@Query(new ZodPipe(savedViewListQuerySchema)) q: z.infer<typeof savedViewListQuerySchema>, @CurrentUser() me: RequestUser) {
    return this.views.list(q.page, me.user);
  }

  @Post()
  create(@Body(new ZodPipe(savedViewCreateSchema)) body: z.infer<typeof savedViewCreateSchema>, @CurrentUser() me: RequestUser) {
    return this.views.create(body, me.user);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser): Promise<void> {
    await this.views.delete(id, me.user);
  }
}
