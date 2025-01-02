import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { RepositoryModule } from '../repository/repository.module';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from '../../enum/constants';
// import { AuthGuard } from '../../guards/auth.guard';
// import { APP_GUARD } from '@nestjs/core';
// , {
//   provide: APP_GUARD,
//     useClass: AuthGuard,
// }

@Module({
  imports: [RepositoryModule,
    JwtModule.register({
      global: true,
      secret: jwtConstants.secret,
      signOptions: { expiresIn: '60s' },
    }),],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
