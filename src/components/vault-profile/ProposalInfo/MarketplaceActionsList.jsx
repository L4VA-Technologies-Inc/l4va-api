import { ExternalLink } from 'lucide-react';

import { IS_PREPROD } from '@/utils/networkValidation';
import { LazyImage } from '@/components/shared/LazyImage';
import { formatAdaPrice } from '@/utils/core.utils';

const ActionField = ({ label, value, children, className }) => (
  <div className="flex justify-between items-center">
    <div className="text-gray-400 text-sm">{label}</div>
    {children || <div className={`text-white text-sm ${className}`}>{value || 'N/A'}</div>}
  </div>
);

export const MarketplaceActionsList = ({ actions, type = 'marketplace' }) => {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  // Check if this is a DexHunter swap action
  // DexHunter swaps have market='DexHunter' OR have slippage field (unique to swaps)
  const isDexHunterSwap = actions[0]?.market === 'DexHunter' || actions[0]?.slippage !== undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between">
        <div className="text-gray-400">Actions</div>
        <div className="text-white">{actions.length} action(s)</div>
      </div>
      <div className="space-y-4 pl-4 border-l border-steel-750">
        {actions.map((action, index) => (
          <div key={action.assetId} className="space-y-2">
            <div className="text-sm text-gray-500">Action {index + 1}</div>
            <div className="space-y-2">
              {isDexHunterSwap ? (
                <>
                  <ActionField label="Market" value={action.market || 'DexHunter'} />
                  <ActionField label="Type" value="Swap to ADA" />
                  {action.assetName && <ActionField label="Token" value={action.assetName} />}
                  {action.assetImg && (
                    <ActionField label="Token Image">
                      <LazyImage
                        src={action.assetImg}
                        alt={action.assetName || 'Token image'}
                        className="rounded-full"
                        width={32}
                        height={32}
                        fallbackSrc="/assets/icons/ada.svg"
                      />
                    </ActionField>
                  )}
                  {action.quantity && <ActionField label="Quantity" value={action.quantity.toLocaleString()} />}
                  {action.slippage !== undefined && (
                    <ActionField label="Slippage Tolerance" value={`${action.slippage}%`} />
                  )}
                  {action.useMarketPrice !== undefined && (
                    <ActionField
                      label="Price Mode"
                      value={action.useMarketPrice ? 'Market Price (at execution)' : 'Custom Price'}
                    />
                  )}
                  {!action.useMarketPrice && action.customPriceAda && (
                    <ActionField label="Custom Price" value={`₳${formatAdaPrice(action.customPriceAda)} per token`} />
                  )}
                  {action.estimatedOutput && (
                    <ActionField label="Estimated Output" value={`₳${formatAdaPrice(action.estimatedOutput)}`} />
                  )}
                  {action.actualOutput && (
                    <ActionField label="Actual Output" value={`₳${formatAdaPrice(action.actualOutput)}`} />
                  )}
                  {action.txHash && (
                    <ActionField label="Transaction">
                      <a
                        href={`${IS_PREPROD ? 'https://preprod.cardanoscan.io' : 'https://cardanoscan.io'}/transaction/${action.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-orange-500 hover:text-orange-400 transition-colors text-sm"
                      >
                        <span>View on Cardanoscan</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </ActionField>
                  )}
                  {action.assetStatus && (
                    <ActionField label="Status" className="uppercase" value={action.assetStatus} />
                  )}
                </>
              ) : type === 'marketplace' ? (
                <>
                  <ActionField label="Exec" value={action.exec} />
                  <ActionField label="Market" value={action.market || 'WayUp'} />
                  {action.assetPrice && String(action.exec || '').toLowerCase() !== 'offer' && (
                    <ActionField label="Floor Price" value={`₳${formatAdaPrice(action.assetPrice)}`} />
                  )}
                  {action.price && (
                    <ActionField
                      label={String(action.exec || '').toLowerCase() === 'offer' ? 'Offered Price' : 'Buying Max Price'}
                      value={`₳${formatAdaPrice(action.price)}`}
                    />
                  )}
                  {action.listingPrice && (
                    <ActionField label="Listing Price" value={`₳${formatAdaPrice(action.listingPrice)}`} />
                  )}
                  {action.newPrice && <ActionField label="New Price" value={`₳${formatAdaPrice(action.newPrice)}`} />}
                  {action.assetName && <ActionField label="Asset Name" value={action.assetName} />}
                  {action.assetImg && (
                    <ActionField label="Asset Image">
                      <LazyImage
                        src={action.assetImg}
                        alt={action.assetName || 'Asset image'}
                        className="rounded-full"
                        width={32}
                        height={32}
                        fallbackSrc="/assets/icons/ada.svg"
                      />
                    </ActionField>
                  )}
                  {action.assetStatus && (
                    <ActionField label="Status" className="uppercase" value={action.assetStatus} />
                  )}
                  {action.wayupUrl && (
                    <ActionField label="Token URL">
                      <a
                        href={action.wayupUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-orange-500 hover:text-orange-400 transition-colors text-sm"
                      >
                        <span>View on WayUp</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </ActionField>
                  )}
                </>
              ) : (
                <>
                  {action.assetName && <ActionField label="Asset Name" value={action.assetName} />}
                  {action.exec && <ActionField label="Exec" value={action.exec} />}
                  {action.quantity && <ActionField label="Quantity" value={action.quantity} />}
                  {action.sellType && <ActionField label="Sell Type" value={action.sellType} />}
                  {action.method && <ActionField label="Method" value={action.method} />}
                  {action.market && <ActionField label="Market" value={action.market} />}
                  {action.assetPrice && <ActionField label="Price" value={`₳${formatAdaPrice(action.assetPrice)}`} />}
                  {action.assetStatus && (
                    <ActionField label="Status" className="uppercase" value={action.assetStatus} />
                  )}
                  {action.wayupUrl && (
                    <ActionField label="Token URL">
                      <a
                        href={action.wayupUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-orange-500 hover:text-orange-400 transition-colors text-sm"
                      >
                        <span>View on WayUp</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </ActionField>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
