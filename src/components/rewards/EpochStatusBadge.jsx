export const EpochStatusBadge = ({ status }) => {
  const configs = {
    active: {
      bg: 'bg-green-500/10',
      border: 'border-green-500/30',
      text: 'text-green-400',
      dot: 'bg-green-500',
      label: 'Active',
      animate: true,
    },
    processing: {
      bg: 'bg-yellow-500/10',
      border: 'border-yellow-500/30',
      text: 'text-yellow-400',
      dot: 'bg-yellow-500',
      label: 'Processing',
      animate: true,
    },
    completed: {
      bg: 'bg-blue-500/10',
      border: 'border-blue-500/30',
      text: 'text-blue-400',
      dot: 'bg-blue-500',
      label: 'Completed',
      animate: false,
    },
  };

  const config = configs[status] || {
    bg: 'bg-gray-500/10',
    border: 'border-gray-500/30',
    text: 'text-gray-400',
    dot: 'bg-gray-500',
    label: status,
    animate: false,
  };

  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border ${config.bg} ${config.border}`}>
      <div className={`w-2 h-2 rounded-full ${config.dot} ${config.animate ? 'animate-pulse' : ''}`} />
      <span className={`text-xs font-medium ${config.text}`}>{config.label}</span>
    </div>
  );
};
