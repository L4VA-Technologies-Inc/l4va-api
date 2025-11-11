import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';

@Injectable()
export class SentryMonitoringService {
  captureError(error: Error | string, context?: Record<string, any>) {
    if (typeof error === 'string') {
      Sentry.captureMessage(error, {
        level: 'error',
        extra: context,
      });
    } else {
      Sentry.captureException(error, {
        extra: context,
      });
    }
  }

  captureWarning(message: string, context?: Record<string, any>) {
    Sentry.captureMessage(message, {
      level: 'warning',
      extra: context,
    });
  }

  captureInfo(message: string, context?: Record<string, any>) {
    Sentry.captureMessage(message, {
      level: 'info',
      extra: context,
    });
  }

  setUser(userId: string, userData?: Record<string, any>) {
    Sentry.setUser({
      id: userId,
      ...userData,
    });
  }

  setTag(key: string, value: string) {
    Sentry.setTag(key, value);
  }
}
