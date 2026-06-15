import { useEffect, useMemo, useState } from 'react';
import { Plus, Wallet, X } from 'lucide-react';

import { NoTreasuryWalletAlert } from '../NoTreasuryWalletAlert';

import { validateOptions, validateOption, formatPriceInput } from './shared/transactionHelpers';

import { LavaSteelInput } from '@/components/shared/LavaInput';
import { LavaMultiSelect, LavaSteelSelect } from '@/components/shared/LavaSelect';
import { useVaultAssetsForProposalByType } from '@/services/api/queries';
import { LavaIntervalPicker } from '@/components/shared/LavaIntervalPicker';
import { LavaCheckbox } from '@/components/shared/LavaCheckbox';
import { IS_MAINNET } from '@/utils/networkValidation.ts';

const methodOptions = [
  { value: 'N/A', label: 'Time Limit' },
  { value: 'GTC', label: 'GTC' },
];

const sellTypeOptions = [
  { value: 'List', label: 'List' },
  { value: 'Market', label: 'Market' },
];

export const SellAction = ({ vaultId, onDataChange, error }) => {
  const [options, setOptions] = useState([]);
  const [assetOptions, setAssetOptions] = useState([]);
  const [abstain, setAbstain] = useState(false);

  const { data, isLoading } = useVaultAssetsForProposalByType(vaultId, 'sell');

  const assetsData = data?.data.assets;
  const treasuryInfo = data?.data?.treasuryWalletBalance;
  const treasuryBalance = treasuryInfo?.lovelace / 1000000 || 0;

  const remainingAssets = useMemo(() => {
    if (!assetsData) return [];
    const usedAssetNames = options.map(option => option.assetName).filter(Boolean);
    return assetsData.filter(asset => !usedAssetNames.includes(asset.name));
  }, [assetsData, options]);

  const selectedAssets = useMemo(() => {
    return options.map(opt => opt.assetName).filter(Boolean);
  }, [options]);

  useEffect(() => {
    if (assetsData && !isLoading) {
      const formattedAssets = assetsData.map(asset => ({
        value: asset.name,
        label: asset.name,
        id: asset.id,
      }));

      setAssetOptions(formattedAssets);
    }
  }, [assetsData, isLoading]);

  useEffect(() => {
    onDataChange({
      buyingSellingOptions: options,
      abstain,
      isValid: validateOptions(options, false), // false = isBuyType (this is sell)
    });
  }, [options, onDataChange, abstain]);

  const handleOptionChange = (id, field, value) => {
    if (field === 'assetName') {
      const selectedAsset = assetOptions.find(option => option.value === value);
      setOptions(
        options.map(option =>
          option.id === id
            ? {
                ...option,
                [field]: value,
                assetId: selectedAsset?.id || null,
                exec: 'SELL',
              }
            : option
        )
      );
    } else if (field === 'sellType') {
      setOptions(
        options.map(option => (option.id === id ? { ...option, [field]: value, price: '', exec: 'SELL' } : option))
      );
    } else if (field === 'method') {
      setOptions(
        options.map(option => (option.id === id ? { ...option, [field]: value, duration: '', exec: 'SELL' } : option))
      );
    } else {
      setOptions(options.map(option => (option.id === id ? { ...option, [field]: value, exec: 'SELL' } : option)));
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

  const handleAddOption = selectedAssetValues => {
    if (options.length >= 10) return;

    if (selectedAssetValues && Array.isArray(selectedAssetValues)) {
      const newOptions = selectedAssetValues.map(assetValue => {
        const existingOption = options.find(opt => opt.assetName === assetValue);

        if (existingOption) {
          return existingOption;
        }

        const selectedAsset = assetOptions.find(opt => opt.value === assetValue);
        return {
          id: Date.now() + Math.random(),
          assetName: selectedAsset?.label || '',
          assetId: selectedAsset?.id || null,
          exec: 'SELL',
          quantity: '1', // NFTs always have quantity 1
          sellType: '',
          duration: '',
          method: 'N/A',
          market: 'WayUp',
          price: '',
        };
      });

      setOptions(newOptions);
      return;
    }

    setOptions([
      ...options,
      {
        id: Date.now(),
        assetName: '',
        assetId: null,
        exec: 'SELL',
        quantity: '1', // NFTs always have quantity 1
        sellType: '',
        duration: '',
        method: 'N/A',
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
        <h3 className="text-lg font-medium">Sell Options</h3>
        <div className="flex flex-col sm:flex-row gap-3 sm:w-auto w-[100%]">
          <button
            className="flex items-center justify-center gap-2 bg-steel-850 hover:bg-steel-850/70 text-white/60 px-4 py-2 rounded-lg transition-colors w-full border border-steel-750"
            type="button"
            disabled={options.length >= 10}
            onClick={handleAddOption}
          >
            Add Action
            <Plus className="h-4 w-4" />
          </button>
          <LavaMultiSelect
            options={assetOptions.map(asset => ({
              label: asset.label,
              value: asset.value,
            }))}
            value={selectedAssets}
            placeholder="Add Multiple NFTs"
            onChange={handleAddOption}
            className="min-w-[250px]"
          />
        </div>
      </div>

      {options.length === 0 ? (
        <>
          {error && <p className="text-center text-red-600 font-bold py-8">Add actions!</p>}
          {!error && <p className="text-center text-white/60 py-8">Start by clicking Add action</p>}
        </>
      ) : (
        <div className="space-y-8">
          {options.map((option, index) => {
            return (
              <div key={option.id}>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-2">
                  <p className="font-medium">
                    Option {index + 1}{' '}
                    {error && !validateOption(option, false) && (
                      <span className="text-red-600 ml-2">Fill in all inputs!</span>
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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-gray-400 mb-2">Asset Name:</p>
                      <LavaSteelSelect
                        options={assetOptions.filter(
                          opt => opt.value === option.assetName || remainingAssets.some(a => a.name === opt.value)
                        )}
                        placeholder={isLoading ? 'Loading assets...' : 'Select asset'}
                        value={option.assetName}
                        onChange={value => handleOptionChange(option.id, 'assetName', value)}
                        isDisabled={isLoading}
                      />
                    </div>
                    <div>
                      <p className="text-sm text-gray-400 mb-2">Sell Type</p>
                      <LavaSteelSelect
                        options={sellTypeOptions}
                        placeholder="Select type"
                        value={option.sellType}
                        onChange={value => handleOptionChange(option.id, 'sellType', value)}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
                    <div>
                      <p className="text-sm text-gray-400 mb-2">Method</p>
                      <LavaSteelSelect
                        options={methodOptions}
                        placeholder="Select method"
                        value={option.method}
                        onChange={value => handleOptionChange(option.id, 'method', value)}
                      />
                    </div>
                    <div>
                      <p className="text-sm text-gray-400 -mb-2">Duration</p>
                      <LavaIntervalPicker
                        placeholder="Select"
                        value={option.duration}
                        variant="steel"
                        onChange={value => handleOptionChange(option.id, 'duration', value)}
                        disabled={option.method === 'GTC'}
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
                      <p className="text-sm text-gray-400 mb-2">Price</p>
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
                        disabled={option.sellType === 'Market'}
                      />
                    </div>
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
