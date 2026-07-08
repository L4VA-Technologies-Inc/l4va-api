import { useEffect, useState, useCallback } from 'react';
import { Plus, Wallet, X, Loader2, CheckCircle } from 'lucide-react';

import { NoTreasuryWalletAlert } from '../NoTreasuryWalletAlert';

import {
  formatPriceInput,
  validateBuyOptionWithWhitelist,
  validateBuyOptionsWithWhitelist,
  extractPolicyIdFromUnit,
  isPolicyWhitelisted,
} from './shared/transactionHelpers';

import { LavaSteelInput } from '@/components/shared/LavaInput';
import { LavaSteelSelect } from '@/components/shared/LavaSelect';
import { useVaultAssetsForProposalByType, useAssetMetadata } from '@/services/api/queries';
import { LavaCheckbox } from '@/components/shared/LavaCheckbox';
import { IS_MAINNET } from '@/utils/networkValidation.ts';

const buyTypeOptions = [
  { value: 'Offer', label: 'Offer' },
  { value: 'Buy', label: 'Buy' },
];

// Component to handle asset metadata fetching for a single buy option
const BuyOptionMetadataHandler = ({ option, onMetadataChange }) => {
  const [debouncedUnit, setDebouncedUnit] = useState('');

  // Validate unit format: more than 56 hex characters (policy + asset name required)
  const isValidUnit = Boolean(option.assetId && /^[a-fA-F0-9]{57,}$/.test(option.assetId));

  // Clear display name immediately when unit changes
  useEffect(() => {
    onMetadataChange(option.id, {
      displayName: '',
      unit: option.assetId || '',
      isLoading: false,
      error: null,
    });
  }, [option.assetId, option.id, onMetadataChange]);

  // Debounce the unit value
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedUnit(option.assetId || '');
    }, 300);

    return () => clearTimeout(timer);
  }, [option.assetId]);

  // Fetch metadata when debounced unit is valid
  const { data, isLoading, error } = useAssetMetadata(debouncedUnit, isValidUnit);

  // Update parent component when metadata changes
  useEffect(() => {
    // Only update if the response is for the current unit (prevent stale data)
    const currentUnit = option.assetId || '';

    if (data?.data && debouncedUnit === currentUnit) {
      onMetadataChange(option.id, {
        displayName: data.data.displayName,
        unit: currentUnit,
        isLoading: false,
        error: null,
      });
    } else if (error && debouncedUnit === currentUnit) {
      onMetadataChange(option.id, {
        displayName: '',
        unit: currentUnit,
        isLoading: false,
        error: error.message || 'Failed to fetch asset metadata',
      });
    } else if (isLoading && debouncedUnit === currentUnit) {
      onMetadataChange(option.id, {
        displayName: '',
        unit: currentUnit,
        isLoading: true,
        error: null,
      });
    }
  }, [data, isLoading, error, option.id, option.assetId, debouncedUnit, onMetadataChange]);

  return null; // This component doesn't render anything
};

export const BuyAction = ({ vaultId, assetsWhitelist = [], onDataChange, error }) => {
  const [options, setOptions] = useState([]);
  const [abstain, setAbstain] = useState(false);
  const [assetMetadataMap, setAssetMetadataMap] = useState({}); // Map of optionId -> metadata

  const getExecValue = sellType => (sellType === 'Offer' ? 'OFFER' : 'BUY');

  const isOptionPolicyWhitelisted = useCallback(
    option => {
      const policyId = extractPolicyIdFromUnit(option?.assetId);
      return isPolicyWhitelisted(policyId, assetsWhitelist);
    },
    [assetsWhitelist]
  );

  // Handle metadata changes for buy options
  const handleMetadataChange = useCallback((optionId, metadata) => {
    setAssetMetadataMap(prev => ({
      ...prev,
      [optionId]: metadata,
    }));

    // Update the option with assetName (for validation) and displayName (for historical reference)
    setOptions(prevOptions =>
      prevOptions.map(opt =>
        opt.id === optionId
          ? {
              ...opt,
              assetName: metadata.displayName || '',
              displayName: metadata.displayName || '',
            }
          : opt
      )
    );
  }, []);

  const { data, isLoading } = useVaultAssetsForProposalByType(vaultId, 'sell');

  const treasuryInfo = data?.data?.treasuryWalletBalance;
  const treasuryBalance = treasuryInfo?.lovelace / 1000000 || 0;

  useEffect(() => {
    onDataChange({
      buyingSellingOptions: options,
      abstain,
      isValid: validateBuyOptionsWithWhitelist(options, assetsWhitelist),
    });
  }, [options, onDataChange, abstain, assetsWhitelist]);

  const handleOptionChange = (id, field, value) => {
    if (field === 'assetId') {
      setOptions(
        options.map(option =>
          option.id === id
            ? {
                ...option,
                assetId: value,
                exec: getExecValue(option.sellType),
              }
            : option
        )
      );
    } else if (field === 'sellType') {
      setOptions(
        options.map(option =>
          option.id === id ? { ...option, [field]: value, price: '', exec: getExecValue(value) } : option
        )
      );
    } else {
      setOptions(
        options.map(option =>
          option.id === id ? { ...option, [field]: value, exec: getExecValue(option.sellType) } : option
        )
      );
    }
  };

  const handleAmountChange = (id, field, value) => {
    const formattedValue = formatPriceInput(value);

    if (Number(formattedValue) <= 0) {
      setOptions(options.map(option => (option.id === id ? { ...option, [field]: '' } : option)));
      return;
    }

    setOptions(options.map(option => (option.id === id ? { ...option, [field]: formattedValue } : option)));
  };

  const handleAddOption = () => {
    if (options.length >= 10) return;

    setOptions([
      ...options,
      {
        id: Date.now(),
        assetName: '',
        assetId: '',
        exec: 'BUY',
        quantity: '',
        sellType: 'Buy',
        market: 'WayUp',
        price: '',
      },
    ]);
  };

  const handleRemoveOption = id => setOptions(options.filter(option => option.id !== id));

  if (IS_MAINNET && (isLoading || !treasuryInfo)) {
    return <NoTreasuryWalletAlert isLoading={isLoading} />;
  }

  return (
    <>
      <div className="bg-steel-800 rounded-lg p-4">
        <div className="flex items-center gap-2 text-white/60 mb-2">
          <Wallet className="w-4 h-4" />
          <span className="text-sm">Treasury Balance</span>
        </div>
        <p className="text-2xl font-semibold text-white">{treasuryBalance.toLocaleString()} ADA</p>
      </div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-3">
        <h3 className="text-lg font-medium">Buy Options</h3>
        <button
          className="flex items-center justify-center gap-2 bg-steel-850 hover:bg-steel-850/70 text-white/60 px-4 py-2 rounded-lg transition-colors border border-steel-750"
          type="button"
          disabled={options.length >= 10}
          onClick={handleAddOption}
        >
          Add Action
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {options.length === 0 ? (
        <>
          {error && <p className="text-center text-red-600 font-bold py-8">Add actions!</p>}
          {!error && <p className="text-center text-white/60 py-8">Start by clicking Add action</p>}
        </>
      ) : (
        <div className="space-y-8">
          {options.map((option, index) => {
            const metadata = assetMetadataMap[option.id] || {};
            const isPolicyInvalid =
              Boolean(option.assetId) &&
              option.assetId.length >= 56 &&
              !isOptionPolicyWhitelisted(option) &&
              !metadata.isLoading;
            const isOptionInvalid = !validateBuyOptionWithWhitelist(option, assetsWhitelist);

            return (
              <div key={option.id}>
                <BuyOptionMetadataHandler option={option} onMetadataChange={handleMetadataChange} />
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-2">
                  <p className="font-medium">
                    Option {index + 1}{' '}
                    {error && isOptionInvalid && (
                      <span className="text-red-600 ml-2">
                        {option.assetId && option.assetId.length > 0 && option.assetId.length < 56
                          ? 'Asset ID must be at least 56 characters!'
                          : isPolicyInvalid
                            ? 'Asset policy is not whitelisted for this vault!'
                            : 'Fill in all inputs!'}
                      </span>
                    )}
                  </p>
                  <button
                    className="bg-red-600/10 hover:bg-red-600/20 text-red-600 text-sm px-3 py-1 rounded-md flex items-center gap-1.5 transition-colors self-start sm:self-auto"
                    type="button"
                    onClick={() => handleRemoveOption(option.id)}
                  >
                    <X className="h-4 w-4" />
                    Remove
                  </button>
                </div>
                <div className="relative bg-steel-800 p-4 rounded-[10px]">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <p className="text-sm text-gray-400">Display Name:</p>
                        {metadata.displayName && metadata.unit === option.assetId && option.assetId.length > 56 && (
                          <a
                            href={`https://www.wayup.io/collection/${option.assetId.substring(0, 56)}/asset/${option.assetId.substring(56)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-orange-500 hover:text-orange-400 hover:underline"
                          >
                            WayUp
                          </a>
                        )}
                      </div>
                      {metadata.isLoading ? (
                        <div className="flex items-center gap-2 px-3 py-2.5 bg-steel-900/50 border border-steel-700/50 rounded-lg">
                          <Loader2 className="w-4 h-4 animate-spin text-orange-500 flex-shrink-0" />
                          <span className="text-sm text-gray-400">Loading asset metadata...</span>
                        </div>
                      ) : metadata.displayName && metadata.unit === option.assetId ? (
                        <div className="flex items-center gap-2 px-3 py-2.5 bg-green-900/20 border border-green-500/30 rounded-lg">
                          <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                          <span className="text-sm text-gray-200 break-words">{metadata.displayName}</span>
                        </div>
                      ) : metadata.error && metadata.unit === option.assetId ? (
                        <div className="px-3 py-2.5 bg-red-900/20 border border-red-500/30 rounded-lg">
                          <p className="text-xs text-red-400">{metadata.error}</p>
                        </div>
                      ) : (
                        <div className="px-3 py-2.5 bg-steel-900/50 border border-steel-750 rounded-lg">
                          <span className="text-sm text-gray-500 italic">Enter asset unit</span>
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="text-sm text-gray-400 mb-2">Exec Type</p>
                      <LavaSteelSelect
                        options={buyTypeOptions}
                        placeholder="Select type"
                        value={option.sellType ?? buyTypeOptions[1].value}
                        onChange={value => handleOptionChange(option.id, 'sellType', value)}
                      />
                    </div>
                    <div>
                      <p className="text-sm text-gray-400 mb-2">Market</p>
                      <LavaSteelSelect
                        placeholder="Select market"
                        value={option.market}
                        onChange={value => handleOptionChange(option.id, 'market', value)}
                        options={[{ value: 'WayUp', label: 'WayUp' }]}
                      />
                    </div>
                    <div>
                      <p className="text-sm text-gray-400 mb-2">
                        {option.sellType === 'Offer' ? 'Offer Price (ADA)' : 'Max Buy Price (ADA)'}
                      </p>
                      <LavaSteelInput
                        type="number"
                        min={0}
                        step={0.1}
                        placeholder="0.00"
                        value={option.price}
                        onChange={value => handleAmountChange(option.id, 'price', value)}
                        onIncrement={() => {
                          const newValue = (parseFloat(option.price) || 0) + 0.1;
                          handleAmountChange(option.id, 'price', newValue.toFixed(1));
                        }}
                        onDecrement={() => {
                          const newValue = Math.max(0, (parseFloat(option.price) || 0) - 0.1);
                          handleAmountChange(option.id, 'price', newValue.toFixed(1));
                        }}
                      />
                    </div>
                  </div>
                  <div>
                    <p className="text-sm text-gray-400 mb-2">Asset Unit:</p>
                    <LavaSteelInput
                      type="text"
                      placeholder="Enter asset unit"
                      value={option.assetId || ''}
                      onChange={value => handleOptionChange(option.id, 'assetId', value)}
                      className={
                        (option.assetId && option.assetId.length > 0 && option.assetId.length < 56) || isPolicyInvalid
                          ? '!border-red-500/60'
                          : ''
                      }
                    />
                    {option.assetId && option.assetId.length > 0 && option.assetId.length < 56 && (
                      <p className="text-xs text-red-500 mt-1">Asset Unit must be at least 56 characters</p>
                    )}
                    {isPolicyInvalid && (
                      <p className="text-xs text-red-500 mt-1">
                        This policy is not in vault asset whitelist. Allowed policy must match one from assets
                        whitelist.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {abstain && (
            <div>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-2">
                <p className="font-medium">Option {options.length + 1}</p>
              </div>
              <div className="relative bg-steel-800 p-4 rounded-[10px]">
                <p className="font-medium">Do nothing</p>
              </div>
            </div>
          )}
        </div>
      )}
      <LavaCheckbox
        checked={abstain}
        label="Abstain"
        labelClassName="text-[20px]"
        onChange={e => setAbstain(e.target.checked)}
      />
    </>
  );
};
