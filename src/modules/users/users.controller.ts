import {ApiTags} from "@nestjs/swagger";
import { Controller, Patch} from "@nestjs/common";
import {UsersService} from "./users.service";

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {
  }


  @Patch('/:userId')
  uploadImage() {
    // return this.usersService.editUser({
    //
    // });
  }

}
