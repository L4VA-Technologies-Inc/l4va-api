import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpException } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

@Injectable()
export class SentryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const startTime = Date.now();

    if (request.user) {
      Sentry.setUser({
        id: request.user.id,
        email: request.user.email,
        username: request.user.username,
      });
    }

    Sentry.setTag('endpoint', `${request.method} ${request.url}`);
    Sentry.setTag('user_agent', request.headers['user-agent']);
    Sentry.setTag('ip', request.ip);

    Sentry.setContext('request', {
      method: request.method,
      url: request.url,
      headers: this.sanitizeHeaders(request.headers),
      query: request.query,
      params: request.params,
    });

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTime;

        Sentry.addBreadcrumb({
          message: `${request.method} ${request.url} - ${duration}ms`,
          category: 'http',
          level: 'info',
          data: {
            duration,
            status: 'success',
          },
        });

        if (duration > 5000) {
          Sentry.captureMessage(`Slow API response: ${request.method} ${request.url}`, {
            level: 'warning',
            tags: {
              endpoint: `${request.method} ${request.url}`,
              performance_issue: 'slow_response',
            },
            extra: {
              duration,
              threshold: 5000,
            },
          });
        }
      }),
      catchError(error => {
        const duration = Date.now() - startTime;

        if (error instanceof HttpException) {
          const status = error.getStatus();

          if (status >= 500) {
            Sentry.captureException(error, {
              tags: {
                endpoint: `${request.method} ${request.url}`,
                status_code: status,
                error_type: 'server_error',
              },
              extra: {
                body: this.sanitizeBody(request.body),
                params: request.params,
                query: request.query,
                duration,
              },
            });
          } else if (status >= 400) {
            Sentry.captureMessage(`${status} Error: ${error.message}`, {
              level: 'warning',
              tags: {
                endpoint: `${request.method} ${request.url}`,
                status_code: status,
                error_type: 'client_error',
              },
              extra: {
                body: this.sanitizeBody(request.body),
                params: request.params,
                query: request.query,
                duration,
                errorMessage: error.message,
                errorResponse: error.getResponse(),
              },
            });
          }
        } else {
          Sentry.captureException(error, {
            tags: {
              endpoint: `${request.method} ${request.url}`,
              error_type: 'unexpected',
            },
            extra: {
              body: this.sanitizeBody(request.body),
              params: request.params,
              query: request.query,
              duration,
            },
          });
        }

        return throwError(() => error);
      })
    );
  }

  private sanitizeHeaders(headers: any): any {
    const sanitized = { ...headers };
    delete sanitized.authorization;
    delete sanitized.cookie;
    delete sanitized['x-api-key'];
    return sanitized;
  }

  private sanitizeBody(body: any): any {
    if (!body) return body;

    const sanitized = { ...body };
    delete sanitized.password;
    delete sanitized.token;
    delete sanitized.secret;
    delete sanitized.privateKey;

    return sanitized;
  }
}
