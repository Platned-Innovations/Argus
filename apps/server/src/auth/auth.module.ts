import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard, CsrfGuard, PermissionsGuard } from './guards';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, ApiTokensController],
  providers: [ApiTokensService, AuthService, PasswordService, TokenService, MfaService, AuthGuard, CsrfGuard, PermissionsGuard],
  exports: [PasswordService, TokenService, AuthGuard, CsrfGuard, PermissionsGuard],
})
export class AuthModule {}
