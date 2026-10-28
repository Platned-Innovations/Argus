import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SeedAdminService } from './seed-admin.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService, SeedAdminService],
})
export class UsersModule {}
