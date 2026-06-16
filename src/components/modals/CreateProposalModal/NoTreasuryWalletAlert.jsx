import { AlertCircle } from 'lucide-react';

/**
 * Alert component displayed when a vault doesn't have a treasury wallet configured.
 * Used across various proposal action types that require treasury wallet functionality.
 * @param {boolean} isLoading - Whether treasury info is currently being loaded
 */
export const NoTreasuryWalletAlert = ({ isLoading = false }) => {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
        <span className="ml-3 text-white/60">Loading treasury info...</span>
      </div>
    );
  }

  return (
    <div className="bg-red-900/20 border border-red-500/30 rounded-lg p-4">
      <div className="flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-red-400" />
        <div>
          <p className="text-red-400 font-medium">No Treasury Wallet</p>
          <p className="text-white/60 text-sm mt-1">
            This vault does not have a treasury wallet configured. This action requires a treasury wallet with ADA
            funds.
          </p>
        </div>
      </div>
    </div>
  );
};
