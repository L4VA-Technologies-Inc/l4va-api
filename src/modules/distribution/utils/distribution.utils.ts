import { AddressesUtxo, UtxoSelection } from '../distribution.types';

/**
 * Select UTXOs from dispatch address to cover required amount
 */
export function selectDispatchUtxos(dispatchUtxos: AddressesUtxo[], requiredAmount: number): UtxoSelection {
  // Sort UTXOs by amount (largest first for efficiency)
  const sortedUtxos = dispatchUtxos.sort((a, b) => {
    const amountA = parseInt(a.amount.find(u => u.unit === 'lovelace')?.quantity || '0');
    const amountB = parseInt(b.amount.find(u => u.unit === 'lovelace')?.quantity || '0');
    return amountB - amountA;
  });

  const selectedUtxos: AddressesUtxo[] = [];
  let totalAmount = 0;

  for (const utxo of sortedUtxos) {
    const utxoAmount = parseInt(utxo.amount.find(u => u.unit === 'lovelace')?.quantity || '0');
    selectedUtxos.push(utxo);
    totalAmount += utxoAmount;

    if (totalAmount >= requiredAmount) {
      break;
    }
  }

  return { selectedUtxos, totalAmount };
}

/**
 * Validate balance equation for transactions
 */
export function validateBalanceEquation(totalInput: number, totalOutput: number, totalPayment: number): boolean {
  return totalInput >= totalOutput + totalPayment;
}

/**
 * Calculate required minimum lovelace for transaction
 */
export function calculateMinimumLovelace(paymentAmount: number): number {
  return paymentAmount + 1_000_000; // Payment + minimum ADA
}
