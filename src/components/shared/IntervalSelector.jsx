import clsx from 'clsx';

const INTERVALS = [
  { value: '1h', label: '1H' },
  { value: '1d', label: '1D' },
  { value: '1w', label: '1W' },
];

export const IntervalSelector = ({ activeInterval, onIntervalChange, className = '' }) => {
  return (
    <div className={clsx('inline-flex gap-2 rounded-lg p-1 bg-steel-900/60 border border-steel-800/50', className)}>
      {INTERVALS.map(interval => (
        <button
          key={interval.value}
          className={clsx(
            'px-3 py-1.5 rounded-md text-sm font-medium transition-all',
            activeInterval === interval.value
              ? 'bg-orange-500/20 text-orange-400 border border-orange-500/40'
              : 'text-dark-100 hover:text-white hover:bg-steel-800/50'
          )}
          type="button"
          onClick={() => onIntervalChange(interval.value)}
        >
          {interval.label}
        </button>
      ))}
    </div>
  );
};
