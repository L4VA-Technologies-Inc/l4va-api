import { Injectable, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';


@Injectable()
export class AuthService {

  constructor(
    private jwtService: JwtService
  ) {}

  async signIn( username: string, pass: string,): Promise<{ access_token: string }> {
    const payload = { sub: '1', username: 'edik' };
    const token = {access_token: await this.jwtService.signAsync(payload)};
    return token;
  }


}
