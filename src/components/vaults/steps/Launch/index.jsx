import { LaunchConfigureVault } from '@/components/vaults/steps/Launch/LaunchConfigureVault';
import { LaunchAssetContribution } from '@/components/vaults/steps/Launch/LaunchAssetContribution';
import { LaunchAcquireWindow } from '@/components/vaults/steps/Launch/LaunchAcquireWindow';
import { LaunchGovernance } from '@/components/vaults/steps/Launch/LaunchGovernance';
import { useVlrmFeeSettings } from '@/services/api/queries';
import { useNetwork } from '@/hooks/useNetwork';
import { ChainType, ChainTypeLabels } from '@/utils/types';

export const Launch = ({ data, setCurrentStep }) => {
  const { data: vlrmFeeData, isLoading: isVlrmFeeLoading } = useVlrmFeeSettings();
  const { network } = useNetwork();
  const networkLabel = ChainTypeLabels[network] ?? ChainTypeLabels[ChainType.CARDANO];

  const vlrmFeeSettings = vlrmFeeData?.data || {
    vlrm_creator_fee: 1000,
    vlrm_creator_fee_enabled: true,
  };

  const shouldShowVlrmFee = vlrmFeeSettings.vlrm_creator_fee_enabled && !isVlrmFeeLoading;

  return (
    <div className="space-y-12 mt-16 min-w-0 overflow-x-hidden">
      <LaunchConfigureVault data={data} setCurrentStep={setCurrentStep} />
      <LaunchAssetContribution data={data} setCurrentStep={setCurrentStep} />
      <LaunchAcquireWindow data={data} setCurrentStep={setCurrentStep} />
      <LaunchGovernance data={data} setCurrentStep={setCurrentStep} />
      <div className="bg-steel-900/50 border border-steel-800/50 rounded-lg p-4 md:p-6 flex items-center justify-between gap-4">
        <p className="text-base font-medium text-white">This vault will be created on:</p>
        <span className="flex items-center gap-2 text-base font-medium text-white">
          <span className="w-2 h-2 rounded-full bg-orange-500" />
          {networkLabel}
        </span>
      </div>
      <div className="bg-steel-900/50 border border-steel-800/50 rounded-lg p-4 md:p-6">
        <p className="text-sm text-dark-100 mb-2">Transaction Costs:</p>
        <p className="text-base font-medium">
          You will spend:{' '}
          {shouldShowVlrmFee ? (
            <span className="text-white">{vlrmFeeSettings.vlrm_creator_fee} VLRM + ~44.44 ADA</span>
          ) : (
            <span className="text-white">~44.44 ADA</span>
          )}
        </p>
        <p className="text-sm text-dark-100 mt-1">(39 ADA is upload on-chain fee that will be taken)</p>
      </div>
    </div>
  );
};
