export class FeeTooSmallException extends Error {
  constructor(
    message: string,
    public readonly suppliedFee: number,
    public readonly expectedFee: number
  ) {
    super(message);
    this.name = 'FeeTooSmallException';
  }

  static fromErrorMessage(errorMessage: string): FeeTooSmallException {
    // Parse: FeeTooSmallUTxO (Mismatch {mismatchSupplied = Coin 307823, mismatchExpected = Coin 422513})
    const match = errorMessage.match(/FeeTooSmallUTxO.*?mismatchSupplied = Coin (\d+).*?mismatchExpected = Coin (\d+)/);

    if (match) {
      const suppliedFee = parseInt(match[1], 10);
      const expectedFee = parseInt(match[2], 10);
      const shortfall = expectedFee - suppliedFee;

      return new FeeTooSmallException(
        `Transaction fee too small: supplied ${suppliedFee} lovelace, expected ${expectedFee} lovelace (shortfall: ${shortfall} lovelace)`,
        suppliedFee,
        expectedFee
      );
    }

    return new FeeTooSmallException(`Transaction fee too small: ${errorMessage}`, 0, 0);
  }
}
