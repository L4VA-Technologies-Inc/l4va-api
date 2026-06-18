import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';

import { AppCore } from '@/AppCore';
import { AuthProvider } from '@/lib/auth/auth.context';

import '@/css/index.css';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE || 'production',

  tracesSampleRate: import.meta.env.MODE === 'production' ? 0.1 : 1.0,

  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  profilesSampleRate: 1.0,

  integrations: [
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: false,
      maskAllInputs: true,
    }),
    Sentry.browserTracingIntegration({
      traceFetch: true,
      traceXHR: true,
    }),
  ],

  beforeSend(event, hint) {
    if (event.exception) {
      const error = hint.originalException;

      if (error?.message?.includes('Network Error') || error?.message?.includes('Failed to fetch')) {
        return null;
      }

      if (error?.stack?.includes('extension://') || error?.stack?.includes('chrome-extension://')) {
        return null;
      }

      if (error?.stack?.includes('googleapis.com') || error?.stack?.includes('google-analytics.com')) {
        return null;
      }
    }

    return event;
  },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
      onError: error => {
        Sentry.captureException(error, {
          tags: {
            error_type: 'api_query',
            component: 'react_query',
          },
        });
      },
    },
    mutations: {
      onError: error => {
        Sentry.captureException(error, {
          tags: {
            error_type: 'api_mutation',
            component: 'react_query',
          },
        });
      },
    },
  },
});

// Easter egg: L4VA logo
console.log(
  `%c
██╗     ██╗  ██╗██╗   ██╗ █████╗ 
██║     ██║  ██║██║   ██║██╔══██╗
██║     ███████║██║   ██║███████║
██║     ╚════██║╚██╗ ██╔╝██╔══██║
███████╗     ██║ ╚████╔╝ ██║  ██║
╚══════╝     ╚═╝  ╚═══╝  ╚═╝  ╚═╝

`,
  'color:#ff4d00;font-weight:bold;text-shadow:0 0 8px #ff2200;'
);

// redepeloy
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppCore />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
);
