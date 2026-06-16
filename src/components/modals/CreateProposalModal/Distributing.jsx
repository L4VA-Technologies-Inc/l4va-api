import { useEffect, useState } from 'react';
import { AlertCircle, Wallet, Users, Info } from 'lucide-react';

import { NoTreasuryWalletAlert } from './NoTreasuryWalletAlert';

import { LavaSteelInput } from '@/components/shared/LavaInput';
import { LavaCheckbox } from '@/components/shared/LavaCheckbox.jsx';
import { useVaultAssetsForProposalByType } from '@/services/api/queries';
import { formatAdaPrice } from '@/utils/core.utils';

export default function Distributing({ isDisabled, onDataChange, vaultId }) {
  const [adaAmount, setAdaAmount] = useState('');
  const [distributeAll, setDistributeAll] = useState(false);
  const { data, isLoading } = useVaultAssetsForProposalByType(vaultId, 'distribute');

  // Distribution info from backend
  const distributionInfo = data?.data;
  const treasuryBalance = distributionInfo?.treasuryBalance?.lovelace || 0;
  const treasuryBalanceAda = treasuryBalance / 1000000;
  const maxDistributableAda = distributionInfo?.maxDistributableAda || 0;
  const vtHolderCount = distributionInfo?.vtHolderCount || 0;
  const minAdaPerHolder = distributionInfo?.minAdaPerHolder || 2;
  const warnings = distributionInfo?.warnings || [];
  const hasTreasuryWallet = distributionInfo?.hasTreasuryWallet ?? false;

  // Validation
  const enteredAda = parseFloat(adaAmount) || 0;
  const enteredLovelace = Math.floor(enteredAda * 1000000);
  const isOverBalance = enteredAda > maxDistributableAda; // Use max distributable instead of raw balance
  const adaPerHolder = vtHolderCount > 0 ? enteredAda / vtHolderCount : 0;
  const hasNoFunds = hasTreasuryWallet && treasuryBalanceAda === 0;
  // Allow distribution even if some holders get less than minimum - they will be skipped
  // Only block if amount is too small to give anyone the minimum (less than 2 ADA total)
  const noOneWillReceive = enteredAda > 0 && enteredAda < minAdaPerHolder;
  const isValid = enteredAda > 0 && !isOverBalance && !noOneWillReceive && hasTreasuryWallet && !hasNoFunds;

  const handleDistributeAllChange = checked => {
    setDistributeAll(checked);
    if (checked) {
      // Use max distributable ADA (treasury minus fee reserve)
      setAdaAmount(maxDistributableAda.toFixed(6));
    } else {
      setAdaAmount('');
    }
  };

  const handleAdaAmountChange = value => {
    setAdaAmount(value);
    // Uncheck "distribute all" if user manually changes amount
    if (distributeAll && parseFloat(value) !== treasuryBalanceAda) {
      setDistributeAll(false);
    }
  };

  // Notify parent of changes
  useEffect(() => {
    if (onDataChange) {
      onDataChange({
        distributionLovelaceAmount: isValid ? enteredLovelace : null,
        isValid: isValid,
      });
    }
  }, [enteredLovelace, isValid, onDataChange]);

  // Auto-check "distribute all" if user enters the exact max distributable amount
  useEffect(() => {
    if (!distributeAll && Math.abs(enteredAda - maxDistributableAda) < 0.000001 && maxDistributableAda > 0) {
      setDistributeAll(true);
    }
  }, [enteredAda, maxDistributableAda, distributeAll]);

  if (isDisabled) {
    return (
      <div className="bg-red-900/20 border border-red-500/30 rounded-lg p-4">
        <div className="flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400" />
          <div>
            <p className="text-red-400 font-medium">Distribution Not Available</p>
            <p className="text-white/60 text-sm mt-1">Distribution proposals are not available currently</p>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || !hasTreasuryWallet) {
    return <NoTreasuryWalletAlert isLoading={isLoading} />;
  }

  return (
    <div className="space-y-6">
      {/* Distribution Amount Input */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium text-white">Distribution Amount</h3>
          <LavaCheckbox
            checked={distributeAll}
            onChange={e => handleDistributeAllChange(e.target.checked)}
            description="Distribute All"
            disabled={treasuryBalanceAda <= 0}
          />
        </div>

        <div className="bg-steel-800 rounded-lg p-4 space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <LavaSteelInput
                type="number"
                label="Amount (ADA)"
                placeholder="0.00"
                value={adaAmount}
                onChange={handleAdaAmountChange}
                className={isOverBalance || noOneWillReceive ? 'border-red-500/60' : ''}
              />
            </div>
          </div>

          {/* Validation Messages */}
          {isOverBalance && (
            <div className="flex items-center gap-2 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4" />
              <span>
                Amount exceeds max distributable ({maxDistributableAda.toLocaleString()} ADA). Fee reserve required for
                transaction.
              </span>
            </div>
          )}

          {noOneWillReceive && (
            <div className="flex items-center gap-2 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4" />
              <span>Minimum {minAdaPerHolder} ADA required for at least one holder to receive distribution</span>
            </div>
          )}

          {enteredAda > 0 && adaPerHolder > 0 && adaPerHolder < minAdaPerHolder && !noOneWillReceive && (
            <div className="flex items-center gap-2 text-yellow-400 text-sm">
              <AlertCircle className="w-4 h-4" />
              <span>
                Some holders with smaller VT balances may not receive distribution (minimum {minAdaPerHolder} ADA per
                recipient)
              </span>
            </div>
          )}
        </div>
      </div>
      {/* Treasury Info Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-steel-800 rounded-lg p-4">
          <div className="flex items-center gap-2 text-white/60 mb-2">
            <Wallet className="w-4 h-4" />
            <span className="text-sm">Treasury Balance</span>
          </div>
          <p className="text-2xl font-semibold text-white">{treasuryBalanceAda.toLocaleString()} ADA</p>
          <p className="text-xs text-green-400 mt-1">Max Distributable: {maxDistributableAda.toLocaleString()} ADA</p>
          <p className="text-xs text-white/40">
            (Fees reserved: {formatAdaPrice(treasuryBalanceAda - maxDistributableAda)} ADA)
          </p>
        </div>

        <div className="bg-steel-800 rounded-lg p-4">
          <div className="flex items-center gap-2 text-white/60 mb-2">
            <Users className="w-4 h-4" />
            <span className="text-sm">VT Holders</span>
          </div>
          <p className="text-2xl font-semibold text-white">{vtHolderCount.toLocaleString()}</p>
          <p className="text-xs text-white/40 mt-1">Min {minAdaPerHolder} ADA per holder required</p>
        </div>
      </div>

      {/* Info Section */}
      <div className="bg-steel-800/50 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-400 mt-0.5" />
          <div className="text-sm text-white/70">
            <p className="font-medium text-white/90 mb-2">How Distribution Works</p>
            <ul className="space-y-1 list-disc list-inside">
              <li>ADA is distributed proportionally based on VT holdings</li>
              <li>Minimum 2 ADA per recipient (Cardano UTXO requirement)</li>
              <li>Distribution is processed in batches of ~200 recipients</li>
              <li>Claims are created for each recipient to track status</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Warnings from Backend */}
      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((warning, index) => (
            <div
              key={index}
              className="flex items-center gap-2 text-yellow-400 text-sm bg-yellow-900/20 rounded-lg p-3"
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}

      {/* Summary */}
      {enteredAda > 0 && isValid && (
        <div className="bg-green-900/20 border border-green-500/30 rounded-lg p-4">
          <p className="text-green-400 font-medium mb-2">Distribution Summary</p>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-white/60">Total Amount:</span>
              <span className="ml-2 text-white">{enteredAda.toLocaleString()} ADA</span>
            </div>
            <div>
              <span className="text-white/60">Recipients:</span>
              <span className="ml-2 text-white">{vtHolderCount.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-white/60">Est. Batches:</span>
              <span className="ml-2 text-white">{Math.ceil(vtHolderCount / 200)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
