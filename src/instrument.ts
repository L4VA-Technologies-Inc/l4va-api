import * as Sentry from '@sentry/nestjs';
import { config } from 'dotenv';

config();

Sentry.init({
  dsn: process.env.SENTRY_DNS_KEY,

  sendDefaultPii: true,

  environment: process.env.NODE_ENV || 'prod',

  tracesSampleRate: 0.1,

  profilesSampleRate: 0.1,

  integrations: [Sentry.httpIntegration()],

  beforeSend(event) {
    if (event.request?.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
    }

    if (event.request?.data) {
      const data = event.request.data;
      if (typeof data === 'object') {
        ['password', 'token', 'secret'].forEach(key => {
          if (key in data) {
            data[key] = '[Filtered]';
          }
        });
      }
    }

    return event;
  },
});
