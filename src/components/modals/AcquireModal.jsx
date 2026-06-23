import { useState } from 'react';
import { useWallet } from '@ada-anvil/weld/react';
import toast from 'react-hot-toast';
import { ChevronUp, ChevronDown } from 'lucide-react';

import PrimaryButton from '@/components/shared/PrimaryButton';
import { HoverHelp } from '@/components/shared/HoverHelp';
import { formatNum } from '@/utils/core.utils';
import { useCurrency } from '@/hooks/useCurrency';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCreateAcquireTx, useBuildTransaction, useSubmitTransaction } from '@/services/api/queries';
import { Spinner } from '@/components/Spinner';

export const AcquireModal = ({ vault, onClose }) => {
  const { name, tokensForAcquires, liquidityPoolContribution, ftTokenSupply } = vault;
  const { currency, currencySymbol } = useCurrency();
  const [acquireAmount, setAcquireAmount] = useState(0);
  const { mutateAsync: createAcquireTx } = useCreateAcquireTx();
  const wallet = useWallet('handler', 'isConnected', 'balanceAda', 'balanceDecoded', 'isUpdatingUtxos');
  const [status, setStatus] = useState('idle');
  const buildTransaction = useBuildTransaction();
  const submitTransaction = useSubmitTransaction();

  // Use vault-specific max acquire amount if available, otherwise fallback to 10M ADA
  const maxAcquireAmount = vault.maxAcquireAmountAda || 10000000;
  const maxValue = Math.floor(Math.min(wallet.balanceAda || 0, maxAcquireAmount));

  const acquireAmountNum = parseFloat(acquireAmount) || 0;

  // TVL (Total Value Locked) - the value of contributed assets
  const tvl = vault.assetsPrices?.totalValueAda || 0;
  const totalAcquiredAda = vault.assetsPrices?.totalAcquiredAda || 0;

  // Fair value ADA = expected total ADA if FDV equals TVL
  // e.g., if TVL = 10,000 and tokensForAcquires = 50%, fairValueAda = 5,000
  const fairValueAda = tvl * (tokensForAcquires / 100);

  // Calculate user share based on fair value projection or actual total acquired
  // - Before fair value is reached: project based on fair value (more intuitive estimate)
  // - After fair value exceeded: use actual total (reflects real dilution)
  let userShare = 0;
  if (acquireAmountNum > 0 && fairValueAda > 0) {
    // Total ADA that would be in the pool after this acquisition
    const totalAfterAcquisition = totalAcquiredAda + acquireAmountNum;

    if (totalAfterAcquisition >= fairValueAda) {
      // Total would exceed fair value - use actual amounts
      userShare = acquireAmountNum / totalAfterAcquisition;
    } else {
      // Total below fair value - project as if fair value will be reached
      userShare = acquireAmountNum / fairValueAda;
    }
  }

  // Net % available for acquirers (after LP contribution)
  const totalAvailableTokenPercent = tokensForAcquires * (1 - liquidityPoolContribution / 100 / 2);
  const totalAvailableTokenAmount = Math.floor((totalAvailableTokenPercent / 100) * ftTokenSupply);

  // Est Vault Token (%) = user's share of the acquirer pool
  const estVaultTokenPercent = totalAvailableTokenPercent * userShare;
  // Est Vault Token Amount = estimated token amount user will receive
  const estVaultTokenAmount = Math.floor(totalAvailableTokenAmount * userShare);

  const handleAcquire = async () => {
    setStatus('building');

    try {
      if (!acquireAmount || parseFloat(acquireAmount) <= 0) return;

      const { data } = await createAcquireTx({
        vaultId: vault.id,
        assets: [
          {
            assetName: 'lovelace',
            policyId: 'lovelace',
            type: 'ADA',
            quantity: Number(acquireAmount),
          },
        ],
      });

      const changeAddress = await wallet.handler.getChangeAddressBech32();

      const buildResult = await buildTransaction.mutateAsync({
        changeAddress,
        vaultId: vault.id,
        txId: data.txId,
        outputs: [
          {
            assets: data.assets,
          },
        ],
      });

      if (!buildResult.data?.presignedTx) {
        throw new Error('Failed to build transaction');
      }

      setStatus('signing');
      const signature = await wallet.handler.signTx(buildResult.data.presignedTx, true);

      if (!signature) {
        throw new Error('Transaction signing was cancelled');
      }

      setStatus('submitting');
      const submitResult = await submitTransaction.mutateAsync({
        transaction: buildResult.data.presignedTx,
        vaultId: vault.id,
        txId: data.txId,
        signatures: [signature],
      });

      if (submitResult.data?.txHash) {
        toast.success('Acquisition completed successfully');
        onClose();
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Acquisition failed');
      setStatus('idle');
    }
  };

  const handleAmountChange = e => {
    let value = e.target.value;

    value = value.replace(/[^0-9.]/g, '');

    const parts = value.split('.');
    if (parts.length > 2) value = parts[0] + '.' + parts.slice(1).join('');

    if (value.includes('.')) {
      const [int, dec] = value.split('.');
      value = int + '.' + dec.slice(0, 2);
    }

    if (Number(value) > maxValue) {
      value = maxValue.toString();
    }

    setAcquireAmount(value);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-xl p-0 bg-steel-950 text-white border-none">
        <DialogHeader className="py-2 bg-white/5 rounded-t-lg">
          <DialogTitle className="text-2xl text-center font-medium">Acquire {name}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col p-6 space-y-6">
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <span>ADA in wallet</span>
              <span className="font-bold">{formatNum(wallet.balanceAda || 0)} ADA</span>
            </div>
            <div className="bg-steel-850 p-4 rounded-lg">
              <h3 className="font-bold mb-2">Acquire</h3>
              <div className="flex items-center gap-4">
                <input
                  className="bg-transparent text-4xl w-full outline-none font-bold"
                  type="text"
                  value={acquireAmount}
                  onChange={handleAmountChange}
                />
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const newValue = Math.min(parseFloat(acquireAmount || 0) + 1, maxValue);
                      setAcquireAmount(newValue.toString());
                    }}
                    className="p-1 hover:bg-steel-700 rounded transition-colors"
                  >
                    <ChevronUp className="transition-transform duration-200" size={20} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const newValue = Math.max(parseFloat(acquireAmount || 0) - 1, 0);
                      setAcquireAmount(newValue.toString());
                    }}
                    className="p-1 hover:bg-steel-700 rounded transition-colors"
                  >
                    <ChevronDown className="transition-transform duration-200" size={20} />
                  </button>
                </div>
                <span className="text-2xl font-bold">ADA</span>
              </div>
              {acquireAmountNum > 0 && acquireAmountNum < 5 && (
                <div className="mt-3 text-xs text-yellow-400">
                  Minimum 5 ADA required to cover transaction fees and ensure meaningful vault token allocation
                </div>
              )}
              {maxAcquireAmount < 10000000 && (
                <div className="mt-3 text-xs text-zinc-400">
                  Maximum acquire limit for this vault: {formatNum(maxAcquireAmount)} ADA per transaction
                </div>
              )}
              {acquireAmountNum > maxAcquireAmount && (
                <div className="mt-3 text-xs text-red-400">
                  Amount exceeds maximum limit of {formatNum(maxAcquireAmount)} ADA per transaction
                </div>
              )}
            </div>
          </div>
          <div className="bg-slate-950 p-6 rounded-[10px]">
            <h2 className="text-xl text-center font-medium mb-8">Acquire</h2>
            <div className="grid grid-cols-2 gap-6">
              <div className="text-center">
                <p className="text-dark-100 text-sm flex items-center justify-center gap-1.5">
                  Est. Vault Token (%)
                  <HoverHelp hint="Your estimated share of vault tokens as a percentage, based on your ADA amount relative to total ADA from acquirers (or fair value)." />
                </p>
                <p className="text-xl font-medium">{estVaultTokenPercent.toFixed(2)}%</p>
              </div>
              <div className="text-center">
                <p className="text-dark-100 text-sm flex items-center justify-center gap-1.5">
                  Est. Vault Token Amount
                  <HoverHelp hint="Estimated number of vault tokens you will receive for this acquisition." />
                </p>
                <p className="text-xl font-medium">{formatNum(estVaultTokenAmount)}</p>
              </div>
              <div className="space-y-1 text-center">
                <p className="text-dark-100 text-sm m-0 flex items-center justify-center gap-1.5">
                  Total % available for acquirers
                  <HoverHelp hint="Net percentage of vault token supply allocated to acquirers after the liquidity pool share is reserved." />
                </p>
                <p className="text-xl font-medium">{formatNum(totalAvailableTokenPercent)}%</p>
              </div>
              <div className="text-center">
                <p className="text-dark-100 text-sm flex items-center justify-center gap-1.5">
                  Total ADA sent by acquirers
                  <HoverHelp hint="Total amount all acquirers have sent to this vault so far." />
                </p>
                <p className="text-xl font-medium">
                  {currencySymbol}
                  {formatNum(
                    currency === 'ada' ? vault.assetsPrices.totalAcquiredAda : vault.assetsPrices.totalAcquiredUsd
                  )}
                </p>
              </div>
            </div>

            <div className="flex flex-col items-center mt-8 gap-2">
              <PrimaryButton
                className="uppercase"
                disabled={
                  status !== 'idle' || wallet.isUpdatingUtxos || acquireAmountNum < 5 || !vault.isAcquireWindowActive
                }
                onClick={handleAcquire}
                icon={status !== 'idle' ? Spinner : null}
              >
                {wallet.isUpdatingUtxos ? 'Updating UTXOs...' : status === 'idle' ? 'ACQUIRE' : status.toUpperCase()}
              </PrimaryButton>
              <div className="text-xs text-dark-100">
                Transaction cost:{' '}
                <span className="text-white font-medium">
                  ~{((vault.protocolAcquiresFeeAda || 0) + 1.72).toFixed(2)} ADA
                </span>{' '}
                (
                {vault.protocolAcquiresFeeAda > 0
                  ? `${vault.protocolAcquiresFeeAda?.toFixed(2)} ADA Protocol fees + ~1.72 ADA Network fees`
                  : '~1.72 ADA Network fees'}
                )
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
