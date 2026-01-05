import { BadRequestException } from '@nestjs/common';

export class ValueNotConservedException extends BadRequestException {
  constructor(
    public readonly supplied: string,
    public readonly expected: string,
    message?: string
  ) {
    super(
      message ||
        `Transaction value is not balanced. The inputs don't match the outputs. ` +
          `This usually means the transaction was built incorrectly. ` +
          `Expected: ${expected}, but got: ${supplied}`
    );
  }
}
