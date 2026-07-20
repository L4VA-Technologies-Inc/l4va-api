import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import { VaultCountdown } from '@/components/vault-profile/VaultCountdown';
import { SocialPlatformIcon } from '@/components/shared/SocialPlatformIcon';
import { InfoRow } from '@/components/ui/infoRow';
import { formatCompactNumber, formatVaultStatus } from '@/utils/core.utils';
import { ChainTypeLabels, VaultShortResponse } from '@/utils/types';
import L4vaIcon from '@/icons/l4va.svg?react';

type VaultListItemProps = {
  vault: VaultShortResponse;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const VaultListItem = ({ vault }: VaultListItemProps) => {
  const { id, name, description, vaultImage, socialLinks = [] } = vault;

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
    <div className="relative mb-6">
      <Link className="block" to={`/vaults/${id}`} search={linkSearch}>
        <div className="hidden md:block absolute bottom-9 left-2.5 w-[98px] h-[98px] rounded-2xl overflow-hidden">
          {vaultImage ? (
            <img alt={`${name} vault avatar`} src={vaultImage} className="object-cover w-full h-full" />
          ) : (
            <div className="h-full w-full bg-steel-850 flex items-center justify-center">
              <L4vaIcon className="h-12 w-12 text-white" />
            </div>
          )}
        </div>
        <div className="flex md:ml-[120px] items-center justify-between gap-4 mb-3">
          <div className="flex items-center gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-xl">{name || 'No name'}</h3>
                {vault.chainType && (
                  <span className="rounded-full bg-steel-850 px-3 py-0.5 text-xs font-medium text-white">
                    {ChainTypeLabels[vault.chainType] ?? vault.chainType}
                  </span>
                )}
              </div>
              <p className="text-sm text-dark-100">{description || 'No description'}</p>
            </div>
          </div>
          <InfoRow copyable label={id} value={id} labelClassName="max-w-[120px] truncate" hideValue />
        </div>
        <div className="grid grid-cols-4 md:grid-cols-5 gap-4 py-4 text-center border-[var(--color-steel-750)] border rounded-2xl bg-[var(--color-steel-950)] md:pl-[110px]">
          <div>
            <p className="text-sm text-dark-100">TVL</p>
            <p className="font-bold">{vault.tvl ? formatCompactNumber(vault.tvl) : 'N/A'}</p>
          </div>

          <div className="border-x border-slate-800">
            <p className="text-sm text-dark-100">Ticker</p>
            <p className="font-bold capitalize">{vault.vaultTokenTicker || 'N/A'}</p>
          </div>

          <div className="hidden md:block">
            <p className="text-sm text-dark-100">Stage</p>
            <p className="font-bold">{formatVaultStatus(vault.vaultStatus)}</p>
          </div>
          {shouldShowCountdown && (
            <div className="hidden md:block">
              <p className="text-sm text-dark-100">Time Left</p>
              <VaultCountdown
                className="text-base font-normal"
                color="yellow"
                countdownValue={vault.phaseEndTime ? new Date(vault.phaseEndTime).getTime() : ''}
              />
            </div>
          )}
          <div className="flex items-center justify-center gap-3 h-10">
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
      </Link>
    </div>
  );
};

export default VaultListItem;
