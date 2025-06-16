import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TaptoolsModule } from 'src/modules/taptools/taptools.module';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1d' },
      }),
      inject: [ConfigService],
    }),
    TaptoolsModule,
  ],
  exports: [JwtModule, TaptoolsModule], // Експортуємо JwtModule, щоб він був доступний у всіх модулях
})
export class JwtGlobalModule {}
