import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { SeedAdminService } from './seed-admin.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule],
  controllers: [UsersController, InvitesController],
  providers: [UsersService, InvitesService, SeedAdminService],
})
export class UsersModule {}
