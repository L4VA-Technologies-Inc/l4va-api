import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import { VaultCountdown } from '@/components/vault-profile/VaultCountdown';
import { GoldenVerifiedBadge, OFFICIAL_PARTNER_BADGE_HINT } from '@/components/shared/GoldenVerifiedBadge';
import { SocialPlatformIcon } from '@/components/shared/SocialPlatformIcon';
import { formatCompactNumber, formatString, formatVaultStatus } from '@/utils/core.utils';
import { ChainTypeLabels, VaultShortResponse } from '@/utils/types';
import { useCurrency } from '@/hooks/useCurrency';
import L4vaIcon from '@/icons/l4va.svg?react';

type VaultCardProps = {
  vault: VaultShortResponse;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const VaultCard = ({ vault }: VaultCardProps) => {
  const { id, name, description, vaultImage, ftTokenImg, socialLinks = [] } = vault;
  const { currency } = useCurrency();

  const shouldShowCountdown = useMemo(() => {
    if (!vault?.phaseEndTime || !vault?.phaseStartTime) return false;

    const phaseStart = new Date(vault.phaseStartTime).getTime();
    const phaseEnd = new Date(vault.phaseEndTime).getTime();
    const tenPercentThreshold = (phaseEnd - phaseStart) * 0.1;

    const isLessThanOneDay = vault.timeRemaining <= ONE_DAY_MS && vault.timeRemaining > 0;
    const isLessThanTenPercent = vault.timeRemaining <= tenPercentThreshold && vault.timeRemaining > 0;

    return isLessThanOneDay && isLessThanTenPercent;
  }, [vault.phaseStartTime, vault.phaseEndTime, vault.timeRemaining]);

  const linkSearch = useMemo(() => {
    if (vault.vaultStatus === 'acquire' || vault.vaultStatus === 'acquire_expansion') {
      return { tab: 'Token' };
    }
    return undefined;
  }, [vault.vaultStatus]);

  return (
    <div className="w-full max-w-md rounded-xl bg-steel-950 overflow-hidden flex flex-col">
      <Link className="block flex-1 flex flex-col" to={`/vaults/${id}`} search={linkSearch}>
        <div className="relative h-52">
          {vaultImage ? (
            <img alt="Vault avatar" className="h-full w-full object-cover" src={vaultImage} loading="lazy" />
          ) : (
            <div className="h-full w-full bg-steel-850 flex items-center justify-center">
              <L4vaIcon className="h-8 w-8 text-white" />
            </div>
          )}
          {vault.chainType && (
            <span className="absolute top-3 right-3 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm">
              {ChainTypeLabels[vault.chainType] ?? vault.chainType}
            </span>
          )}
          {shouldShowCountdown && (
            <div className="absolute bottom-0 left-0 w-3/4">
              <VaultCountdown
                className="text-base font-normal"
                color="yellow"
                countdownValue={vault.phaseEndTime ? new Date(vault.phaseEndTime).getTime() : ''}
              />
            </div>
          )}
        </div>

        <div className="p-6 flex-1 flex flex-col">
          <div className="flex items-center gap-4 mb-6">
            {ftTokenImg ? (
              <img alt="Token icon" className="h-16 w-16 rounded-xl object-cover" src={ftTokenImg} loading="lazy" />
            ) : (
              <div className="h-16 w-16 rounded-xl bg-primary-background flex items-center justify-center flex-shrink-0">
                <L4vaIcon className="h-8 w-8 text-white" />
              </div>
            )}
            <div>
              <div className="flex items-center gap-1.5">
                <h2 className="font-bold">{name || 'No name'}</h2>
                {vault.isOfficialPartner && (
                  <GoldenVerifiedBadge size="sm" hint={OFFICIAL_PARTNER_BADGE_HINT} label="Official L4VA partner" />
                )}
              </div>
              <p className="text-sm text-dark-100 line-clamp-3">{description || 'No description'}</p>
            </div>
          </div>
          <div className="mb-6 grid grid-cols-3 gap-4 text-center mt-auto">
            <div>
              <p className="text-sm text-dark-100">TVL</p>
              <p className="font-bold">
                {vault.totalValueAda && vault.totalValueUsd
                  ? currency === 'ada'
                    ? `₳${formatCompactNumber(vault.totalValueAda)}`
                    : `$${formatCompactNumber(vault.totalValueUsd)}`
                  : 'N/A'}
              </p>
            </div>
            <div className="border-x border-slate-800">
              <p className="text-sm text-dark-100">Ticker</p>
              <p className="capitalize font-bold">${formatString(vault.vaultTokenTicker) || 'N/A'}</p>
            </div>
            <div>
              <p className="text-sm text-dark-100">Stage</p>
              <p className="font-bold">{formatVaultStatus(vault.vaultStatus)}</p>
            </div>
          </div>
        </div>
      </Link>

      <div className="flex items-center justify-center gap-3 h-10 px-6 pb-6">
        {socialLinks.length > 0 ? (
          socialLinks.map((social, index) => (
            <a key={index} href={social.url} rel="noopener noreferrer" target="_blank">
              <SocialPlatformIcon className="text-white" platformId={social.name} />
            </a>
          ))
        ) : (
          <span className="text-dark-100 text-sm">No social links</span>
        )}
      </div>
    </div>
  );
};
