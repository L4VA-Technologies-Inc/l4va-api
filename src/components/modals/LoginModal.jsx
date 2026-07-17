import { useState, useEffect, useMemo } from 'react';
import { Check, Download } from 'lucide-react';
import { SUPPORTED_WALLETS } from '@ada-anvil/weld';
import { useExtensions, useWallet } from '@ada-anvil/weld/react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import toast from 'react-hot-toast';

import { useModal, useModalControls } from '@/lib/modals/modal.context';
import { useAuth } from '@/lib/auth/auth';
import { useNetwork } from '@/hooks/useNetwork';
import { Spinner } from '@/components/Spinner';
import PrimaryButton from '@/components/shared/PrimaryButton';
import { LavaCheckbox } from '@/components/shared/LavaCheckbox';
import { ModalWrapper } from '@/components/shared/ModalWrapper';
import { validateWalletNetwork } from '@/utils/networkValidation';
import { robinhoodChain } from '@/lib/evm/wagmi.config';
import WalletIcon from '@/icons/wallet.svg?react';

const TERMS_ACCEPTANCE_KEY = 'dexhunter_terms_accepted';
const TERMS_ACCEPTANCE_SERVICE_KEY = 'service_terms_accepted';

const messageHex = msg =>
  Array.from(msg)
    .map(char => char.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');

const TermsAgreementText = () => {
  return (
    <>
      I have read and accepted the{' '}
      <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-orange-500 hover:underline">
        Privacy Policy
      </a>{' '}
      and{' '}
      <a href="/terms-of-service" target="_blank" rel="noopener noreferrer" className="text-orange-500 hover:underline">
        Terms of Use
      </a>
      .
    </>
  );
};

export const LoginModal = () => {
  const { activeModalData } = useModal();
  const { openModal, closeModal } = useModalControls();
  const { isRobinHood, network } = useNetwork();
  const { isAuthenticated, login, logout } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [view, setView] = useState('wallets');
  const installed = useExtensions('supportedMap');

  // Robinhood Chain (EVM) — connect via wagmi, then log in by address (no signature).
  const { isConnected: isRobinhoodConnected } = useAccount();
  const {
    connectors,
    connect: connectRobinhood,
    isPending: isRobinhoodConnecting,
    variables: robinhoodConnectVars,
  } = useConnect();
  const { disconnectAsync: disconnectRobinhood } = useDisconnect();

  // Dedupe EIP-6963 wallets by id (StrictMode can announce them twice) and drop the
  // generic "injected" fallback — leaving only real, installed wallets (empty if none).
  const robinhoodConnectors = useMemo(() => {
    const seen = new Set();
    const tempConnectors = connectors.map(v => ({
      ...v,
      displayName: v.name,
      key: v.id,
      installed: v.type === 'injected',
    }));
    const unique = tempConnectors.filter(connector => {
      if (seen.has(connector.id)) return false;
      seen.add(connector.id);
      return true;
    });
    return unique.filter(connector => connector.id !== 'injected');
  }, [connectors]);

  // Backend authenticates EVM users by wallet address only (no signature).
  const loginWithRobinhoodAddress = async address => {
    if (!address) return;
    const res = await login(null, null, address, network);
    if (!res?.user) return;

    closeModal();
    if (!res.user.email) {
      openModal('EmailModal');
    }
    if (activeModalData?.props?.onSuccess) {
      activeModalData.props.onSuccess();
    }
  };

  const handleRobinhoodConnect = async connector => {
    if (!connector || isRobinhoodConnecting) return;
    // wagmi throws "Connector already connected" if a session is active — drop it first.
    if (isRobinhoodConnected) {
      await disconnectRobinhood();
    }
    connectRobinhood(
      { connector, chainId: robinhoodChain.id },
      {
        onSuccess: data => {
          loginWithRobinhoodAddress(data?.accounts?.[0]);
        },
        onError: error => {
          if (error?.message?.includes('already pending')) {
            toast.error('Check your wallet — a connection request is already open');
          } else {
            toast.error(error?.message || 'Failed to connect wallet');
          }
        },
      }
    );
  };

  const wallet = useWallet(
    'isConnectingTo',
    'isConnected',
    'handler',
    'stakeAddressBech32',
    'changeAddressBech32',
    'networkId'
  );
  const connect = useWallet('connect');
  const disconnect = useWallet('disconnect');

  const [isChecked, setIsChecked] = useState(() => {
    const savedAcceptance = localStorage.getItem(TERMS_ACCEPTANCE_KEY);
    return savedAcceptance === 'true';
  });

  const [isCheckedService, setIsCheckedService] = useState(() => {
    const savedAcceptanceService = localStorage.getItem(TERMS_ACCEPTANCE_SERVICE_KEY);
    return savedAcceptanceService === 'true';
  });

  const handleDisconnect = (keepModalOpen = false) => {
    disconnect();
    logout();
    if (!keepModalOpen) {
      closeModal();
    }
  };

  const handleTermsAcceptance = () => {
    const newValue = !isChecked;
    setIsChecked(newValue);
    localStorage.setItem(TERMS_ACCEPTANCE_KEY, newValue.toString());
  };

  const handleTermsAcceptanceService = () => {
    const newValue = !isCheckedService;
    setIsCheckedService(newValue);
    localStorage.setItem(TERMS_ACCEPTANCE_SERVICE_KEY, newValue.toString());
  };

  const handleConnect = walletKey => {
    if (!walletKey) {
      toast.error('Please select a wallet');
      return;
    }

    if (!isChecked || !isCheckedService) {
      toast.error('Please accept the terms and conditions');
      return;
    }

    setIsLoading(true);
    if (isRobinHood) {
      const connector = connectors.find(c => c.id === walletKey);
      handleRobinhoodConnect(connector);
    } else {
      connect(walletKey, {
        onSuccess: ({ changeAddressBech32 }) => {
          const { isValid, networkType } = validateWalletNetwork(changeAddressBech32);

          if (!isValid) {
            disconnect();
            closeModal();
            openModal('MainNetModal', {
              networkType,
              onDisconnect: handleDisconnect,
            });
          } else {
            console.log('Successfully connected to wallet');
          }
        },
        onError: error => {
          const errorMessage = error?.message || 'Failed to connect to wallet';
          toast.error(errorMessage);
          console.error('Error connecting to wallet:', error);
        },
      });
    }

    setIsLoading(false);
  };

  const handleSignMessage = async () => {
    if (!wallet.isConnected || !wallet.handler) {
      toast.error('Wallet is not connected');
      return false;
    }

    setIsLoading(true);

    try {
      const message = `account: ${wallet.stakeAddressBech32}`;
      const signature = await wallet.handler.signData(messageHex(message));
      const res = await login(signature, wallet.stakeAddressBech32, wallet.changeAddressBech32, network);

      if (!res?.user?.address) {
        toast.error('Failed to authenticate: Invalid response from server');
        return false;
      }
      const { isValid, networkType } = validateWalletNetwork(res.user.address, wallet.changeAddressBech32);
      if (!isValid) {
        disconnect();
        logout();
        closeModal();
        openModal('MainNetModal', {
          networkType,
          onDisconnect: handleDisconnect,
        });
        return false;
      }

      closeModal();

      if (!res.user?.email) {
        openModal('EmailModal');
      }

      if (activeModalData?.props?.onSuccess) {
        activeModalData.props.onSuccess();
      }

      return true;
    } catch (error) {
      console.error('Authentication failed:', error);
      toast.error('Authentication failed. Please try again.');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (wallet.isConnected) {
      setView('sign');
    } else {
      setView('wallets');
    }
  }, [wallet.isConnected]);

  const renderWalletsList = () => {
    const excludedWallets = ['nufiSnap', 'tokeo', 'flint'];
    const cardanoWallets = SUPPORTED_WALLETS.filter(wallet => !excludedWallets.includes(wallet.key));
    const filteredWallets = isRobinHood ? robinhoodConnectors : cardanoWallets;
    return (
      <>
        <div className="space-y-2 max-h-[30vh] overflow-y-auto px-1">
          {isRobinHood && filteredWallets.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <WalletIcon className="w-8 h-8 text-dark-100" />
              <p className="text-sm text-dark-100">
                No wallet detected. Install a browser wallet like{' '}
                <a
                  href="https://metamask.io/download/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-orange-500 hover:underline"
                >
                  MetaMask
                </a>
                ,{' '}
                <a
                  href="https://rabby.io/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-orange-500 hover:underline"
                >
                  Rabby
                </a>{' '}
                or{' '}
                <a
                  href="https://www.coinbase.com/wallet/downloads"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-orange-500 hover:underline"
                >
                  Coinbase Wallet
                </a>{' '}
                to connect.
              </p>
            </div>
          )}
          {filteredWallets.map(wallet => {
            const isConnecting = isRobinHood
              ? isRobinhoodConnecting && robinhoodConnectVars?.connector?.id === wallet.key
              : wallet.isConnectingTo === wallet.key;
            return (
              <button
                key={wallet.key}
                className="
              flex items-center justify-between w-full p-2 bg-steel-950 rounded-lg
              transition-colors disabled:opacity-50 hover:bg-steel-750
            "
                disabled={isConnecting || !isChecked || !isCheckedService}
                type="button"
                onClick={() => handleConnect(wallet.key)}
              >
                <div className="flex items-center gap-2">
                  {wallet.icon ? (
                    <img alt="wallet" className="w-6 h-6" src={wallet.icon} />
                  ) : (
                    <WalletIcon className="w-6 h-6" />
                  )}
                  <span className="font-bold text-sm">{wallet.displayName}</span>
                </div>
                {isConnecting && <Spinner />}
                {!isRobinHood && !installed.has(wallet.key) && (
                  <a
                    className="text-sm text-dark-100 p-1"
                    href={wallet.website}
                    rel="noopener noreferrer"
                    target="_blank"
                    onClick={e => e.stopPropagation()}
                  >
                    <Download className="w-4 h-4" size={14} />
                  </a>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-4 md:mt-6">
          <LavaCheckbox
            checked={isChecked}
            description="I have read and accepted the terms of the DexHunter Privacy Policy and Terms of Use"
            name="terms"
            onChange={handleTermsAcceptance}
          />
          <LavaCheckbox
            checked={isCheckedService}
            description={<TermsAgreementText />}
            name="service-terms"
            onChange={handleTermsAcceptanceService}
          />
        </div>
      </>
    );
  };

  const renderSignMessage = () => (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between w-full mb-3 sm:mb-4">
        <div className="flex items-center gap-2">
          <Check className="w-6 h-6 sm:w-[30px] sm:h-[30px] text-orange-500" />
          <div className="text-sm sm:text-base">Wallet connected</div>
        </div>
      </div>
      <div className="flex items-center justify-between w-full mb-3 sm:mb-4">
        <div className="flex items-center gap-2">
          {isAuthenticated ? (
            <Check className="w-6 h-6 sm:w-[30px] sm:h-[30px] text-orange-500" />
          ) : (
            <div className="w-6 h-6 sm:w-[30px] sm:h-[30px] bg-yellow-500/20 rounded-full flex items-center justify-center text-orange-500">
              2
            </div>
          )}
          <div className="text-sm sm:text-base">Sign Message</div>
        </div>
      </div>
      <div className="flex justify-center">
        <PrimaryButton disabled={isLoading} icon={isLoading ? Spinner : undefined} onClick={handleSignMessage}>
          {isLoading ? 'Signing Message...' : 'Sign Message'}
        </PrimaryButton>
      </div>
      <div className="text-sm mt-4">
        Having issues? Try{' '}
        <span className="cursor-pointer text-orange-500 hover:underline" onClick={handleDisconnect}>
          disconnecting
        </span>{' '}
        your wallet
      </div>
    </div>
  );

  return (
    <ModalWrapper isOpen title="Connect Wallet" onClose={closeModal} size="md">
      {view === 'wallets' ? renderWalletsList() : renderSignMessage()}
    </ModalWrapper>
  );
};
