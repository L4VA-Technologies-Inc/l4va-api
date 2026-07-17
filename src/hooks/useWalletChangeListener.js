import { useEffect, useRef } from 'react';
import { useWallet } from '@ada-anvil/weld/react';

import { useAuth } from '@/lib/auth/auth';
import { useNetwork } from '@/hooks/useNetwork';

const checkWeldCookies = () => {
  const requiredCookies = ['weld_connected-wallet', 'weld_connected-stake', 'weld_connected-change'];

  return requiredCookies.every(cookieName => {
    return document.cookie.split('; ').some(cookie => cookie.startsWith(`${cookieName}=`));
  });
};

export const useWalletChangeListener = () => {
  const wallet = useWallet('isConnected', 'stakeAddressBech32');
  const { user, logout, isAuthenticated } = useAuth();
  const { isRobinHood } = useNetwork();
  const previousStakeAddressRef = useRef(null);

  // Proactively clear DexHunter localStorage when auth/wallet becomes invalid
  useEffect(() => {
    if (!isAuthenticated || !wallet.isConnected) {
      localStorage.removeItem('dexhunter-selected-wallet');
    }
  }, [isAuthenticated, wallet.isConnected]);

  useEffect(() => {
    // Weld/Cardano-only watchdog — EVM (Robinhood) has no Weld wallet/stake address.
    if (isRobinHood || !isAuthenticated || !user) {
      previousStakeAddressRef.current = null;
      return;
    }

    const currentStakeAddress = wallet.stakeAddressBech32;

    if (!previousStakeAddressRef.current && currentStakeAddress) {
      const authenticatedStakeAddress = localStorage.getItem('authenticated_stake_address');

      if (authenticatedStakeAddress && authenticatedStakeAddress !== currentStakeAddress) {
        logout('Wallet changed. Please login again.');
        return;
      }

      previousStakeAddressRef.current = currentStakeAddress;
      return;
    }

    if (!wallet.isConnected && previousStakeAddressRef.current) {
      logout('Wallet disconnected. Please login again.');
      previousStakeAddressRef.current = null;
      return;
    }

    if (currentStakeAddress && previousStakeAddressRef.current !== currentStakeAddress) {
      logout('Wallet changed. Please login again.');
      previousStakeAddressRef.current = null;
    }
  }, [wallet.isConnected, wallet.stakeAddressBech32, user, isAuthenticated, logout, isRobinHood]);

  useEffect(() => {
    // Weld cookie check would fire for EVM logins (no Weld cookies) and wrongly log them out.
    if (isRobinHood || !isAuthenticated || !user) {
      return;
    }

    const checkCookies = () => {
      const hasCookies = checkWeldCookies();

      if (!hasCookies) {
        logout('Wallet session expired. Please login again.');
        previousStakeAddressRef.current = null;
      }
    };

    checkCookies();

    const intervalId = setInterval(checkCookies, 5000);

    return () => clearInterval(intervalId);
  }, [isAuthenticated, user, logout, isRobinHood]);
};
