import { useState, useEffect, useCallback } from 'react';

export type NetworkType = 'cardano' | 'robinhood';

const NETWORK_STORAGE_KEY = 'selectedNetwork';

// Normalize network value to ensure it's always valid
const normalizeNetwork = (value: string | null): NetworkType => {
  return value === 'robinhood' ? 'robinhood' : 'cardano';
};

let globalNetwork: NetworkType = normalizeNetwork(localStorage.getItem(NETWORK_STORAGE_KEY));
const subscribers = new Set<(newNetwork: NetworkType) => void>();

const notifySubscribers = (newNetwork: NetworkType) => {
  globalNetwork = newNetwork;
  subscribers.forEach(callback => callback(newNetwork));
};

export const useNetwork = (): {
  network: NetworkType;
  isCardano: boolean;
  isRobinHood: boolean;
  updateNetwork: (newNetwork: NetworkType) => void;
} => {
  const [network, setNetwork] = useState<NetworkType>(globalNetwork);

  const updateLocalNetwork = useCallback((newNetwork: NetworkType) => {
    setNetwork(newNetwork);
  }, []);

  useEffect(() => {
    subscribers.add(updateLocalNetwork);

    setNetwork(globalNetwork);

    return () => {
      subscribers.delete(updateLocalNetwork);
    };
  }, [updateLocalNetwork]);

  const updateNetwork = useCallback((newNetwork: NetworkType) => {
    localStorage.setItem(NETWORK_STORAGE_KEY, newNetwork);
    notifySubscribers(newNetwork);
  }, []);

  return {
    network,
    isCardano: network === 'cardano',
    isRobinHood: network === 'robinhood',
    updateNetwork,
  };
};
