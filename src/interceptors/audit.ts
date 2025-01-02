import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditEntity } from '../entities/audit.entity';
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    @InjectRepository(AuditEntity)
    private auditRepository: Repository<AuditEntity>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url, user } = request;
    const audit = this.auditRepository.create({
      id: uuidv4(),
      vaultId: user?.vaultId || 'anonymous',
      typeRequest: method,
      endpoint: url,
      createdAt: new Date(),
    });
    console.log(audit);
    this.auditRepository.save(audit);

    return next.handle().pipe(
      tap(() => {
      }),
    );
  }
}
