import { useState, useEffect } from 'react';

import { useModal, useModalControls } from '@/lib/modals/modal.context';
import { ModalWrapper } from '@/components/shared/ModalWrapper';
import VaultChart from '@/components/shared/VaultChart';
import VaultMetrics from '@/components/shared/VaultMetrics';
import { IntervalSelector } from '@/components/shared/IntervalSelector';
import { useMarketWithOHLCV } from '@/services/api/queries.js';

export const ChartModal = () => {
  const { activeModalData } = useModal();
  const { closeModal } = useModalControls();
  const { vault } = activeModalData?.props || {};
  const [interval, setInterval] = useState('1d');
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [cachedMarketData, setCachedMarketData] = useState(null);

  const { data, isLoading, isError, error } = useMarketWithOHLCV(vault?.id, interval);

  const notFound =
    isError &&
    (error?.response?.status === 404 ||
      error?.status === 404 ||
      error?.message?.toLowerCase?.().includes('market not found'));

  const marketData = !notFound ? data?.data : null;

  useEffect(() => {
    if (marketData && !isLoading) {
      setHasLoadedOnce(true);
      setCachedMarketData(marketData);
    }
  }, [marketData, isLoading]);

  // Use cached data for metrics (doesn't change with interval), fresh data for chart
  const metricsData = cachedMarketData || marketData;

  return (
    <ModalWrapper isOpen onClose={closeModal} title="Vault Analytics" className="md:max-w-4xl xl:max-w-6xl">
      <div className="space-y-6">
        <VaultMetrics marketData={metricsData} isLoading={isLoading && !notFound && !hasLoadedOnce} />

        {isError && !notFound && (
          <div className="rounded-lg border border-red-500/40 bg-red-950/40 text-red-200 text-sm px-4 py-3">
            Failed to load market data. Please try again later.
          </div>
        )}

        <div className="flex justify-center mb-4">
          <IntervalSelector activeInterval={interval} onIntervalChange={setInterval} />
        </div>

        <VaultChart ohlcvData={marketData?.ohlcv} isLoading={isLoading && !notFound} isNotFound={notFound} />
      </div>
    </ModalWrapper>
  );
};
