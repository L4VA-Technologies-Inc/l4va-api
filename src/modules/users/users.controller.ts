import {ApiTags} from "@nestjs/swagger";
import {Controller} from "@nestjs/common";
import {VaultsService} from "../vaults/vaults.service";

@ApiTags('users')
@Controller('users')
export class VaultsController {
  constructor(private readonly vaultsService: VaultsService) {
  }

}
