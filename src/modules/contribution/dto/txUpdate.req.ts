import {Expose } from 'class-transformer';
import {IsNotEmpty} from 'class-validator';

export class TxUpdateReq {

  @IsNotEmpty()
  @Expose()
  txHash: string;
}
