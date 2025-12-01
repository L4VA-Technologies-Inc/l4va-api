import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class WebhookTxSummaryDto {
  @Expose()
  @ApiProperty({ description: 'Transaction hash', example: '0x1234567890abcdef...' })
  txHash: string;

  @Expose()
  @ApiProperty({ description: 'Updated local transaction IDs', type: [String] })
  updatedLocalTxIds: string[];
}

export class HandleWebhookRes {
  @Expose()
  @ApiProperty({ description: 'Status of the webhook processing', example: 'success' })
  status: string;

  @Expose()
  @ApiProperty({
    description: 'Transaction summary details (array on success) or error message (string on error)',
    oneOf: [{ type: 'array', items: { $ref: '#/components/schemas/WebhookTxSummaryDto' } }, { type: 'string' }],
  })
  details: WebhookTxSummaryDto[] | string;
}
