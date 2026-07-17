import { Link, useRouter } from '@tanstack/react-router';
import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Menu, Bell, X } from 'lucide-react';
import { useCounts, useNotifications } from '@novu/react';

import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@/components/ui/dropdown-menu';
import { ConnectButton } from '@/components/ConnectButton';
import { MenuDrawer } from '@/components/MenuDrawer';
import { useAuth } from '@/lib/auth/auth';
import { useModal, useModalControls } from '@/lib/modals/modal.context';
import { cn } from '@/lib/utils';
import L4vaIcon from '@/icons/l4va.svg?react';
import { LavaSteelSelect } from '@/components/shared/LavaSelect.jsx';
import { useCurrency } from '@/hooks/useCurrency';
import { useNetwork } from '@/hooks/useNetwork';

const navLinks = [
  { to: '/create', label: 'Create', isAuth: true },
  { to: '/vaults?tab=contribution', label: 'Contribute', isAuth: false },
  { to: '/vaults?tab=acquire', label: 'Acquire', isAuth: false },
  { to: '/vaults?tab=govern', label: 'Govern', isAuth: false },
  { to: '/tokens', label: 'Tokens', isAuth: false },
  { to: '/rewards', label: 'Rewards', isAuth: true },
];

const NavLink = React.memo(({ to, label, onClick }) => (
  <Link
    activeProps={{ className: 'text-orange-500' }}
    className="font-medium hover:text-orange-500 transition-colors"
    to={to}
    onClick={onClick}
  >
    {label}
  </Link>
));
NavLink.displayName = 'NavLink';

export const Header = () => {
  const { isAuthenticated } = useAuth();
  const { activeModalData } = useModal();
  const { openModal } = useModalControls();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const { currency: selectedCurrency, updateCurrency } = useCurrency();
  const { network: selectedNetwork, updateNetwork } = useNetwork();

  const currencyOptions = [
    { label: 'ADA', value: 'ada' },
    { label: 'USD', value: 'usdt' },
  ];

  const networkOptions = [
    { label: 'Cardano', value: 'cardano' },
    { label: 'Robinhood', value: 'robinhood' },
  ];

  const { notifications, fetching, readAll, hasMore, isLoading, fetchMore, refetch } = useNotifications();
  const observerTarget = useRef(null);
  const router = useRouter();

  const { counts } = useCounts({
    filters: [{ read: false }],
  });

  const unreadCount = counts?.[0]?.count ?? 0;

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !isLoading) {
          fetchMore();
        }
      },
      { threshold: 0.5 }
    );

    if (observerTarget.current) {
      observer.observe(observerTarget.current);
    }

    return () => observer.disconnect();
  }, [hasMore, isLoading, fetchMore]);

  //const hasBannerShownRef = useRef(false);

  // banner modal for future releases
  // useEffect(() => {
  //   let timer;
  //   if (isAuthenticated && !activeModalData && !hasBannerShownRef.current) {
  //     timer = setTimeout(() => {
  //       hasBannerShownRef.current = true;
  //
  //       openModal('BannerModal');
  //     }, 5000);
  //   }
  //
  //   return () => {
  //     if (timer) {
  //       clearTimeout(timer);
  //     }
  //   };
  // }, [isAuthenticated, activeModalData, openModal]);

  const handleNavClick = useCallback(
    (to, e, isAuth) => {
      if (!isAuthenticated && isAuth) {
        e.preventDefault();
        openModal('LoginModal');
      }
    },
    [isAuthenticated, openModal]
  );

  const handleNotificationClick = vaultId => {
    if (vaultId) {
      router.navigate({ to: `/vaults/${vaultId}` });
      setIsNotificationsOpen(false);
    }
  };

  const toggleMobileMenu = () => setIsMobileMenuOpen(!isMobileMenuOpen);
  const closeMobileMenu = () => setIsMobileMenuOpen(false);

  const renderNotifications = () => {
    return (
      isAuthenticated && (
        <DropdownMenu
          open={isNotificationsOpen}
          onOpenChange={open => {
            setIsNotificationsOpen(open);
            if (open) {
              refetch?.();
              readAll();
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              className="p-2 rounded-full hover:bg-steel-850 transition-colors relative"
              aria-label="Show notifications"
            >
              <Bell className="w-6 h-6" />
              {unreadCount > 0 && <span className="absolute top-1 right-1 w-2 h-2 bg-orange-500 rounded-full" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[380px] p-4 bg-steel-950 border-0 shadow-xl mt-2 max-h-[500px] overflow-y-auto">
            <div className="flex w-full justify-between items-center mb-4">
              <h3 className="font-bold">Notifications</h3>
              <button
                className="p-2 rounded-full hover:bg-steel-850 transition-colors relative mr-2"
                aria-label="Hide notifications"
                onClick={() => {
                  setIsNotificationsOpen(false);
                }}
              >
                <X className="w-6 h-6 text-gray-400" />
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {fetching && notifications?.length === 0 && <div className="text-dark-100">Loading...</div>}
              {notifications?.map(n => (
                <div
                  key={n.id}
                  className="cursor-pointer rounded-xl p-4 bg-steel-900 hover:bg-steel-800 transition"
                  onClick={() => handleNotificationClick(n.data?.vaultId)}
                >
                  <div className="font-medium text-white">{n.subject || 'No subject'}</div>
                  <div className="text-base text-dark-100">{n.body || 'No message'}</div>
                  <div className="text-sm mt-1 text-dark-100 opacity-70">{new Date(n.createdAt).toLocaleString()}</div>
                </div>
              ))}
              {!fetching && notifications?.length === 0 && <div className="text-dark-100">No notifications yet</div>}
              {hasMore && (
                <div ref={observerTarget} className="h-10 flex items-center justify-center">
                  {isLoading && <div className="text-dark-100">Loading more...</div>}
                </div>
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    );
  };

  return (
    <header
      className={cn(
        'h-[var(--header-height)] flex items-center fixed top-0 left-0 right-0 z-50 border-b border-steel-900/50',
        !activeModalData && 'backdrop-blur-md'
      )}
      style={
        activeModalData
          ? { backgroundColor: 'color-mix(in srgb, var(--color-primary-background) 85%, transparent)' }
          : undefined
      }
    >
      <div className="container mx-auto px-4 xl:px-0">
        <nav className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 active" data-status="active" aria-current="page">
            <L4vaIcon className="flex-shrink-0" height={24} width={24} />
            <span className="hidden lg:block text-2xl font-bold uppercase">L4VA</span>
          </Link>
          <div className="flex w-full items-center">
            <div className="hidden lg:flex items-center gap-8 ml-[56px]">
              {navLinks.map(link => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  label={link.label}
                  onClick={e => handleNavClick(link.to, e, link.isAuth)}
                />
              ))}
            </div>
            <div className="flex-1" />
            <div className="flex gap-2">
              <div className="hidden lg:block">
                <LavaSteelSelect
                  options={networkOptions}
                  value={selectedNetwork}
                  disabled={isAuthenticated}
                  onChange={val => {
                    updateNetwork(val);
                  }}
                />
              </div>
              <div className="hidden lg:block">
                <LavaSteelSelect
                  options={currencyOptions}
                  value={selectedCurrency}
                  onChange={val => {
                    updateCurrency(val);
                  }}
                />
              </div>
              {renderNotifications()}
              <ConnectButton />
              <button
                className={cn('p-2 rounded-full hover:bg-steel-850 transition-colors lg:hidden flex')}
                aria-label="Toggle mobile menu"
                onClick={toggleMobileMenu}
              >
                <Menu className="w-6 h-6" />
              </button>
            </div>
          </div>
          <MenuDrawer
            navLinks={navLinks}
            isOpen={isMobileMenuOpen}
            onClose={closeMobileMenu}
            onNavClick={handleNavClick}
          />
        </nav>
      </div>
    </header>
  );
};
