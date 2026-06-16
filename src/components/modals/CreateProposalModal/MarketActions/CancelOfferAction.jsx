import { useState, useMemo, useCallback, useEffect } from 'react';
import { Check, Calendar, TrendingUp, Store, ExternalLink } from 'lucide-react';

import { LazyImage } from '@/components/shared/LazyImage';
import { InfiniteScrollList } from '@/components/shared/InfiniteScrollList';
import { SelectedAssetItem } from '@/components/modals/AssetsList/SelectedAssetItem.jsx';
import { LavaSearchInput } from '@/components/shared/LavaInput.jsx';
import { Spinner } from '@/components/Spinner.jsx';
import { useOffersToCancel } from '@/services/api/queries';

const MAX_NFT_PER_TRANSACTION = 10;
const PAGE_SIZE = 20;

const mapOfferToAsset = asset => {
  return {
    ...asset,
    id: asset.id,
    tokenId: asset.id || `${asset.policy_id}_${asset.asset_id}`,
    name: asset.name || 'Unknown',
    quantity: Number(asset.quantity ?? 0) || 0,
    isNft: true,
    isFungibleToken: false,
    src: asset.imageUrl,
    // Offer-specific details
    offerDetails: {
      listingPrice: asset.formattedListingPrice,
      floorPrice: asset.formattedFloorPrice,
      market: asset.listing_market || 'Unknown',
      listedAt: asset.listed_at ? new Date(asset.listed_at).toLocaleString() : null,
      txHash: asset.listing_tx_hash,
    },
    metadata: {
      policyId: asset.policy_id,
      image: asset.imageUrl,
      assetName: asset.asset_id,
    },
  };
};

const OfferItem = ({ offer, isSelected, isDisabled, onToggle }) => {
  const handleClick = () => {
    if (!isDisabled) {
      onToggle(offer);
    }
  };

  const { offerDetails } = offer;

  return (
    <button
      type="button"
      className={`
        w-full flex items-center gap-3 p-3 rounded-lg transition-all
        ${isSelected ? 'bg-orange-500/10 border-2 border-orange-500' : 'bg-steel-850 border-2 border-transparent hover:border-steel-700'}
        ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
      `}
      onClick={handleClick}
      disabled={isDisabled}
    >
      <div className="relative flex-shrink-0">
        <LazyImage
          alt={offer.name}
          className="w-16 h-16 rounded-lg object-cover"
          height={64}
          src={offer.src || '/placeholder-nft.png'}
          width={64}
        />
        {isSelected && (
          <div className="absolute -top-1 -right-1 bg-orange-500 rounded-full p-1">
            <Check className="w-3 h-3 text-white" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <p className="font-medium text-white truncate">{offer.name}</p>
            {offer.metadata?.policyId && offer.metadata?.assetName && (
              <a
                href={`https://www.wayup.io/collection/${offer.metadata.policyId}/asset/${offer.metadata.assetName}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-orange-500 hover:text-orange-400 transition-colors flex-shrink-0"
                onClick={e => e.stopPropagation()}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
          {offerDetails?.listingPrice && (
            <span className="text-orange-500 font-semibold text-sm whitespace-nowrap">{offerDetails.listingPrice}</span>
          )}
        </div>

        <div className="space-y-1">
          {offerDetails?.market && (
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <Store className="w-3 h-3" />
              <span className="capitalize">{offerDetails.market}</span>
            </div>
          )}

          {offerDetails?.floorPrice && (
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <TrendingUp className="w-3 h-3" />
              <span>Floor: {offerDetails.floorPrice}</span>
            </div>
          )}

          {offerDetails?.listedAt && (
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <Calendar className="w-3 h-3" />
              <span className="truncate">{offerDetails.listedAt}</span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
};

export const CancelOfferAction = ({ vaultId, onDataChange }) => {
  const [selectedNFTs, setSelectedNFTs] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useOffersToCancel(vaultId, {
    limit: PAGE_SIZE,
    search: searchQuery,
  });

  const walletAssets = useMemo(() => {
    const allAssets = data?.pages?.flatMap(page => page.items || []) ?? [];

    return allAssets.map(mapOfferToAsset);
  }, [data]);

  const selectedNFTsCount = selectedNFTs.length;

  const toggleNFT = useCallback(asset => {
    setSelectedNFTs(prevSelected => {
      const isSelected = prevSelected.some(nft => nft.tokenId === asset.tokenId);

      if (isSelected) {
        return prevSelected.filter(nft => nft.tokenId !== asset.tokenId);
      }

      if (prevSelected.length >= MAX_NFT_PER_TRANSACTION) {
        return prevSelected;
      }

      return [...prevSelected, asset];
    });
  }, []);

  const removeNFT = useCallback(tokenId => {
    setSelectedNFTs(prev => prev.filter(nft => nft.tokenId !== tokenId));
  }, []);

  const loadMoreAssets = useCallback(() => fetchNextPage(), [fetchNextPage]);

  const renderOfferItem = useCallback(
    item => {
      const isSelected = selectedNFTs.some(selected => selected.tokenId === item.tokenId);
      const isDisabled = !isSelected && selectedNFTs.length >= MAX_NFT_PER_TRANSACTION;

      return (
        <OfferItem
          key={item.tokenId}
          offer={item}
          isSelected={isSelected}
          isDisabled={isDisabled}
          onToggle={toggleNFT}
        />
      );
    },
    [selectedNFTs, toggleNFT]
  );

  useEffect(() => {
    const formattedAssets = selectedNFTs.map(asset => ({
      id: asset.id,
      ...asset,
      metadata: asset.metadata,
    }));

    onDataChange?.({
      cancelOfferAssets: formattedAssets,
      isValid: formattedAssets.length > 0,
    });
  }, [selectedNFTs, onDataChange]);

  return (
    <>
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-medium">Offers Available to Cancel</h2>
        </div>
        <LavaSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search offers"
          className="bg-steel-850 border-steel-750 text-white placeholder:text-dark-100"
        />
        <div className="space-y-1 h-full flex flex-col">
          <div className="flex justify-between text-dark-100 text-sm px-2">
            <span>Offer Details</span>
            <span>Price</span>
          </div>
          {isLoading ? (
            <div className="flex items-center justify-center h-32">
              <Spinner />
            </div>
          ) : (
            <InfiniteScrollList
              items={walletAssets}
              renderItem={renderOfferItem}
              isLoading={isLoading}
              isLoadingMore={isFetchingNextPage}
              hasNextPage={hasNextPage}
              onLoadMore={loadMoreAssets}
              className="pr-2 max-h-64"
              loadThreshold={50}
            />
          )}
        </div>
      </div>
      <div className="space-y-3">
        <h3 className="text-lg font-medium">Selected Offers ({selectedNFTsCount})</h3>
        <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
          {selectedNFTsCount > 0 ? (
            selectedNFTs.map(asset => <SelectedAssetItem key={asset.tokenId} asset={asset} onRemove={removeNFT} />)
          ) : (
            <div className="text-center py-6 text-dark-100 bg-steel-900/50 rounded-lg border border-steel-800/50">
              <p className="mb-2">No offers selected</p>
              <p className="text-sm">Select offers from above to cancel</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
