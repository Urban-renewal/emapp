import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { HealthController } from './app.controller';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    LoggerModule.forRoot({
      pinoHttp: {
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.token',
        ],
        level: process.env['NODE_ENV'] !== 'production' ? 'debug' : 'info',
      },
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
