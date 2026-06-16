import { useCallback, useMemo } from 'react';

import { LavaTabs } from '@/components/shared/LavaTabs.jsx';
import { Spinner } from '@/components/Spinner.jsx';
import { InfiniteScrollList } from '@/components/shared/InfiniteScrollList.jsx';
import { SelectedAssetItem } from '@/components/modals/AssetsList/SelectedAssetItem.jsx';
import { NFTItem } from '@/components/modals/AssetsList/NFTItem.jsx';
import { FTItem } from '@/components/modals/AssetsList/FTItem.jsx';
import { LavaSearchInput } from '@/components/shared/LavaInput.jsx';

const MAX_NFT_PER_TRANSACTION = 10;
const MAX_FT_PER_TRANSACTION = 10;

// Enhanced NFT/FT items with IPFS support
const EnhancedNFTItem = ({ nft, isSelected, isDisabled, onToggle }) => {
  const enhancedNft = {
    ...nft,
    src: nft.metadata?.image,
  };

  return <NFTItem isSelected={isSelected} isDisabled={isDisabled} nft={enhancedNft} onToggle={onToggle} />;
};

const EnhancedFTItem = ({ ft, amount, isDisabled, onAmountChange }) => {
  const enhancedFt = {
    ...ft,
    src: ft.metadata?.image,
  };

  return <FTItem amount={amount} isDisabled={isDisabled} ft={enhancedFt} onAmountChange={onAmountChange} />;
};

export const AssetsList = ({
  walletAssets,
  isLoading,
  isLoadingMore,
  hasNextPage,
  loadMoreAssets,
  activeTab,
  onTabChange,
  selectedNFTs,
  selectedAmount,
  onToggleNFT,
  onFTAmountChange,
  onRemoveNFT,
  selectedNFTsCount,
  selectedFTsCount,
  renderSelectedItem,
  searchQuery = '',
  onSearchChange,
  showTabs = true,
  title = 'Available Assets',
}) => {
  const filteredAssets = useMemo(() => {
    if (!walletAssets || walletAssets.length === 0) return [];
    return walletAssets;
  }, [walletAssets]);

  const renderAssetItem = useCallback(
    item => {
      if (activeTab === 'NFT') {
        const isSelected = selectedNFTs.some(selected => selected.tokenId === item.tokenId);
        const isDisabled = !isSelected && selectedNFTsCount >= MAX_NFT_PER_TRANSACTION;

        return (
          <EnhancedNFTItem
            key={item.tokenId}
            nft={item}
            isSelected={isSelected}
            isDisabled={isDisabled}
            onToggle={onToggleNFT}
          />
        );
      } else {
        const hasAmount = selectedAmount[item.tokenId] && selectedAmount[item.tokenId] !== '0';
        const isDisabled = !hasAmount && selectedFTsCount >= MAX_FT_PER_TRANSACTION;

        return (
          <EnhancedFTItem
            key={item.tokenId}
            ft={item}
            amount={selectedAmount[item.tokenId] || ''}
            isDisabled={isDisabled}
            onAmountChange={onFTAmountChange}
          />
        );
      }
    },
    [activeTab, selectedNFTs, selectedAmount, selectedNFTsCount, selectedFTsCount, onToggleNFT, onFTAmountChange]
  );

  return (
    <>
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-medium">{title}</h2>
          {showTabs && (
            <LavaTabs activeTab={activeTab} className="bg-steel-850" tabs={['NFT', 'FT']} onTabChange={onTabChange} />
          )}
        </div>
        <LavaSearchInput
          value={searchQuery}
          onChange={onSearchChange}
          placeholder="Search assets"
          className="bg-steel-850 border-steel-750 text-white placeholder:text-dark-100"
        />
        <div className="space-y-1 h-full flex flex-col">
          <div className="flex justify-between text-dark-100 text-sm px-2">
            <span>Asset</span>
            <span>{activeTab === 'FT' ? 'Amount' : 'Policy'}</span>
          </div>
          {isLoading ? (
            <div className="flex items-center justify-center h-32">
              <Spinner />
            </div>
          ) : (
            <InfiniteScrollList
              items={filteredAssets}
              renderItem={renderAssetItem}
              isLoading={isLoading}
              isLoadingMore={isLoadingMore}
              hasNextPage={hasNextPage}
              onLoadMore={loadMoreAssets}
              className="pr-2 max-h-64"
              loadThreshold={50}
            />
          )}
        </div>
      </div>
      <div className="space-y-3">
        <h3 className="text-lg font-medium">Selected Assets ({selectedNFTs.length})</h3>
        <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
          {selectedNFTs.length > 0 ? (
            selectedNFTs.map(asset =>
              renderSelectedItem ? (
                renderSelectedItem(asset)
              ) : (
                <SelectedAssetItem key={asset.tokenId} asset={asset} onRemove={onRemoveNFT} />
              )
            )
          ) : (
            <div className="text-center py-6 text-dark-100 bg-steel-900/50 rounded-lg border border-steel-800/50">
              <p className="mb-2">No assets selected</p>
              <p className="text-sm">Select assets from above to contribute</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
