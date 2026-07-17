import { formatNum } from '@/utils/core.utils.js';
import { useStatistics } from '@/services/api/queries';
import { useCurrency } from '@/hooks/useCurrency';

const getBackgroundColor = index => {
  const colors = ['#c10007', '#e7000b', '#fb2c36', '#ff6467'];
  return colors[index] || colors[colors.length - 1];
};

const StatCard = ({ value, label }) => (
  <div className="text-center p-6">
    <p className="font-russo text-red-600 text-3xl xl:text-4xl font-bold mb-2">{value}</p>
    <p className="font-bold text-lg lg:text-2xl xl:text-3xl">{label}</p>
  </div>
);

const ProgressBar = ({ items, title }) => {
  const { currency, currencySymbol } = useCurrency();

  const total = items.reduce((sum, item) => sum + item.percentage, 0);

  const itemsWithValues = items.map(item => ({
    ...item,
    actualValue: currency === 'ada' ? item.valueAda : item.valueUsd,
  }));

  return (
    <div className="mb-16">
      <h2 className="text-2xl lg:text-5xl xl:text-4xl font-extrabold text-red-600 mb-8">{title}</h2>
      <div className="space-y-8">
        <div className="grid gap-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {itemsWithValues.map((item, index) => (
              <div key={`label-${item.label}`} className="flex items-start gap-3 bg-gray-900/50 p-3 rounded-lg">
                <div className="w-3 h-3 rounded-sm mt-1" style={{ backgroundColor: getBackgroundColor(index) }} />
                <div>
                  <div className="text-dark-100 text-sm lg:text-base">{item.label}</div>
                  <div className="text-base lg:text-lg xl:text-xl font-semibold">{item.percentage.toFixed(2)}%</div>
                  <div className="text-dark-100 text-sm lg:text-base">
                    {currencySymbol}
                    {formatNum(item.actualValue)}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="relative h-[60px] w-full flex rounded-sm">
            {itemsWithValues.map((item, index) => (
              <div
                key={`bar-${item.label}`}
                className="h-full relative group transition-all duration-200 hover:brightness-110"
                style={{
                  width: `${(item.percentage / total) * 100}%`,
                  backgroundColor: getBackgroundColor(index),
                }}
              >
                <div
                  className="fixed top-0 left-0 opacity-0 group-hover:opacity-100 transition-all duration-200 z-[9999]"
                  style={{
                    transform: 'translateX(-50%) translateY(-100%)',
                    left: '50%',
                  }}
                >
                  <div className="bg-steel-950 text-sm py-1 px-2 rounded whitespace-nowrap shadow-lg">
                    {item.label}: {currencySymbol}
                    {formatNum(item.actualValue)}
                    <div className="absolute left-1/2 top-full -translate-x-1/2 -mt-[1px] border-4 border-transparent border-t-steel-850" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const Stats = () => {
  const { data } = useStatistics();
  const statistics = data?.data;
  const { isAda } = useCurrency();

  const formatCurrency = (adaValue, usdValue) => {
    if (isAda) {
      return `₳${formatNum(adaValue)}`;
    } else {
      return `$${formatNum(usdValue)}`;
    }
  };

  const getTotalValue = (adaValue, usdValue) => {
    return isAda ? adaValue : usdValue;
  };

  const stats = statistics
    ? [
        { label: 'Total Vaults', value: statistics.totalVaults?.toString() || '0' },
        { label: 'Assets', value: statistics.totalAssets?.toString() || '0' },
        { label: 'Acquired', value: formatCurrency(statistics.totalAcquiredAda, statistics.totalAcquiredUsd) },
        { label: 'TVL', value: formatCurrency(statistics.totalValueAda, statistics.totalValueUsd) },
      ]
    : [
        { label: 'Total Vaults', value: '0' },
        { label: 'Assets', value: '0' },
        { label: 'Acquired', value: '₳0' },
        { label: 'TVL', value: '₳0' },
      ];

  const statusData = statistics?.vaultsByStage
    ? Object.entries(statistics.vaultsByStage).map(([key, value]) => ({
        label: key.charAt(0).toUpperCase() + key.slice(1),
        percentage: value.percentage,
        valueAda: value.valueAda,
        valueUsd: value.valueUsd,
      }))
    : [];

  const typesData = statistics?.vaultsByType
    ? Object.entries(statistics.vaultsByType).map(([key, value]) => ({
        label: key === 'semiPrivate' ? 'Semi-Private' : key.charAt(0).toUpperCase() + key.slice(1),
        percentage: value.percentage,
        valueAda: value.valueAda,
        valueUsd: value.valueUsd,
      }))
    : [];

  const totalAmount = statistics?.vaultsByType
    ? getTotalValue(
        Object.values(statistics.vaultsByStage).reduce((sum, stage) => sum + stage.valueAda, 0),
        Object.values(statistics.vaultsByStage).reduce((sum, stage) => sum + stage.valueUsd, 0)
      )
    : 0;

  return (
    <div className="container mx-auto py-12 sm:py-16">
      <h1 className="font-russo font-bold text-3xl xl:text-4xl mb-8">QUICK STATS</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 md:gap-8 mb-8">
        {stats.map(stat => (
          <StatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>
      <div className="space-y-16">
        <ProgressBar items={statusData} title="Vault by Stage" totalAmount={totalAmount} />
        <ProgressBar items={typesData} title="Vault by Types" totalAmount={totalAmount} />
      </div>
    </div>
  );
};

export default Stats;
