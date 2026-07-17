import { useId, useState, useRef, useMemo } from 'react';
import { ChevronDown, Check } from 'lucide-react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useClickOutside } from '@/hooks/useClickOutside';
import { LavaSearchInput } from '@/components/shared/LavaInput';
import { Spinner } from '@/components/Spinner';

export const LavaSelect = ({
  label,
  options = [],
  value,
  onChange,
  placeholder = 'Select an option',
  error,
  required = false,
  className,
  id,
  name,
  showSearch = false,
  searchPlaceholder = 'Search...',
  useOldStyle = true,
  noMargin = false,
  disabled = false,
}) => {
  const generatedId = useId();
  const selectId = id || generatedId;
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef(null);

  useClickOutside(dropdownRef, () => {
    setIsOpen(false);
    setSearchQuery('');
  });

  const filteredOptions = useMemo(() => {
    if (!showSearch || !searchQuery) return options;
    return options.filter(option => option.label.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [options, showSearch, searchQuery]);

  const selectedOption = options.find(option => (option.id || option.value) === value);
  const wrapperClass = noMargin ? 'relative' : 'mt-4 relative';

  const toggleDropdown = () => {
    if (disabled) return;
    setIsOpen(prev => !prev);
    if (!isOpen) {
      setSearchQuery('');
    }
  };

  const handleOptionClick = optionValue => {
    setIsOpen(false);
    if (onChange) {
      onChange(optionValue);
    }
  };

  if (useOldStyle) {
    return (
      <div className="w-full">
        {label && (
          <label htmlFor={selectId} className="font-bold flex items-center gap-2 mb-2">
            <span className="uppercase">
              {required ? '*' : ''}
              {label}
            </span>
          </label>
        )}
        <div className={wrapperClass}>
          <Select value={value} onValueChange={onChange} disabled={disabled}>
            <SelectTrigger
              id={selectId}
              name={name}
              className={`
                bg-input-bg py-4 pl-5 pr-5 font-medium border border-steel-850 h-[60px] 
                focus:ring-0 focus:ring-offset-0 w-full
                disabled:opacity-50 disabled:cursor-not-allowed
                ${className}
              `}
            >
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent className="bg-input-bg border border-steel-850 max-h-[300px]">
              {options.map(option => (
                <SelectItem
                  key={option.id || option.value}
                  className="text-dark-100 hover:text-white hover:bg-slate-950 cursor-pointer py-3"
                  value={option.id || option.value}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && <p className="text-red-600 mt-1 text-sm">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={selectId} className="font-bold flex items-center gap-2 mb-2">
          <span className="uppercase">
            {required ? '*' : ''}
            {label}
          </span>
        </label>
      )}

      <div className={wrapperClass}>
        <div ref={dropdownRef} className="relative w-full">
          <button
            id={selectId}
            name={name}
            type="button"
            disabled={disabled}
            className={`
              flex items-center justify-between w-full bg-steel-850 text-white/60 px-4 py-4 rounded-lg transition-colors border border-steel-750 h-[60px]
              ${!disabled ? 'hover:bg-steel-850/70 cursor-pointer' : 'opacity-50 cursor-not-allowed'}
              ${isOpen ? 'border-white/20' : ''}
              ${className}
            `}
            onClick={toggleDropdown}
          >
            <span className={`flex-1 text-left truncate mr-2`}>
              {selectedOption ? selectedOption.label : placeholder}
            </span>
            <ChevronDown
              className={`h-5 w-5 flex-shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {isOpen && !disabled && (
            <div className="absolute left-0 z-50 mt-1 w-full rounded-lg bg-steel-850 shadow-xl border border-steel-750 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-100">
              {showSearch && (
                <div className="p-2 border-b border-steel-750" onClick={e => e.stopPropagation()}>
                  <LavaSearchInput
                    placeholder={searchPlaceholder}
                    value={searchQuery}
                    onChange={setSearchQuery}
                    className="!h-9 bg-steel-900/50 !border-steel-750 focus:!border-white/20 text-sm"
                    autoFocus
                  />
                </div>
              )}

              <div className="overflow-y-auto max-h-60 scrollbar-thin scrollbar-thumb-steel-700 scrollbar-track-transparent">
                {filteredOptions.length === 0 ? (
                  <div className="px-4 py-3 text-center text-white/40 text-sm">No options found</div>
                ) : (
                  filteredOptions.map(option => {
                    const optionValue = option.id || option.value;
                    const isSelected = value === optionValue;
                    return (
                      <button
                        key={optionValue}
                        type="button"
                        className={`
                          w-full px-4 py-2.5 text-left flex items-center gap-3 transition-colors text-sm
                          ${isSelected ? 'bg-white/10' : 'hover:bg-white/5'}
                        `}
                        onClick={() => handleOptionClick(optionValue)}
                      >
                        <div
                          className={`
                            w-5 h-5 flex-shrink-0 flex items-center justify-center border rounded transition-colors
                            ${isSelected ? 'border-white bg-white' : 'border-steel-600 bg-transparent'}
                          `}
                        >
                          {isSelected && <Check size={14} strokeWidth={4} className="text-steel-900" />}
                        </div>
                        <span
                          className={`flex-1 truncate ${isSelected ? 'text-white font-medium' : 'text-white/70'}`}
                          title={option.label}
                        >
                          {option.label}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
        {error && <p className="text-red-600 mt-1 text-sm">{error}</p>}
      </div>
    </div>
  );
};

export const LavaSteelSelect = ({
  options = [],
  value,
  onChange,
  placeholder = 'Select an option',
  className,
  transparent = false,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  const toggleDropdown = () => {
    if (disabled) return;
    setIsOpen(!isOpen);
  };

  const handleOptionClick = optionValue => {
    const option = options.find(opt => opt.value === optionValue);
    if (option?.disabled) {
      return;
    }
    setIsOpen(false);
    if (onChange) {
      onChange(optionValue);
    }
  };

  useClickOutside(dropdownRef, () => setIsOpen(false));

  const selectedOption = options.find(option => option.value === value)?.label || placeholder;

  return (
    <div ref={dropdownRef} className="relative">
      <button
        className={`
          flex items-center justify-between w-full px-4 py-2 ${transparent ? 'bg-transparent' : 'bg-steel-850'} rounded-lg
          border border-steel-750
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          ${className}
        `}
        type="button"
        disabled={disabled}
        onClick={toggleDropdown}
      >
        <span className="truncate mr-2">{selectedOption}</span>
        <ChevronDown className={`h-5 w-5 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div
          className={`absolute left-0 z-10 mt-1 w-full rounded-lg ${transparent ? 'bg-transparent' : 'bg-steel-850'} shadow-lg border border-steel-750`}
        >
          <div className="overflow-y-auto max-h-60">
            {options.map(option => (
              <button
                key={option.value}
                className={`
                  block w-full px-4 py-2 text-left first:rounded-t-lg last:rounded-b-lg
                  ${option.disabled ? 'opacity-50 cursor-not-allowed text-white/40' : 'hover:bg-white/5 cursor-pointer'}
                `}
                type="button"
                onClick={() => handleOptionClick(option.value)}
                disabled={option.disabled}
                title={option.label}
              >
                <span className="block truncate">{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export const LavaMultiSelect = ({
  options = [],
  value = [],
  onChange,
  placeholder = 'Select options',
  className,
  searchPlaceholder = 'Search...',
  showSearch = true,
  showSelectAll = false,
  selectAllLabel = 'Select All',
  isDisabled = false,
  onSearchChange,
  onReachListEnd,
  hasMore = false,
  isInitialLoading = false,
  isFetching = false,
  isFetchingMore = false,
  direction = 'down',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef(null);

  const resetSearch = () => {
    setSearchQuery('');
    onSearchChange?.('');
  };

  const toggleDropdown = () => {
    if (!isDisabled) {
      setIsOpen(!isOpen);
      resetSearch();
    }
  };

  const handleOptionClick = optionValue => {
    const newValue = value.includes(optionValue) ? value.filter(v => v !== optionValue) : [...value, optionValue];

    if (onChange) {
      onChange(newValue);
    }
  };

  useClickOutside(dropdownRef, () => {
    setIsOpen(false);
    resetSearch();
  });

  const filteredOptions = useMemo(() => {
    if (onSearchChange) {
      return options;
    }
    const query = (searchQuery || '').toLowerCase();
    return options.filter(option => (option?.label || '').toLowerCase().includes(query));
  }, [options, searchQuery, onSearchChange]);

  const selectedOptions = useMemo(() => options.filter(option => value.includes(option.value)), [options, value]);

  const selectAllCandidateValues = useMemo(() => filteredOptions.map(o => o.value), [filteredOptions]);
  const isAllSelected = useMemo(() => {
    if (selectAllCandidateValues.length === 0) return false;
    return selectAllCandidateValues.every(v => value.includes(v));
  }, [selectAllCandidateValues, value]);
  const isSomeSelected = useMemo(() => {
    if (selectAllCandidateValues.length === 0) return false;
    return selectAllCandidateValues.some(v => value.includes(v)) && !isAllSelected;
  }, [selectAllCandidateValues, value, isAllSelected]);

  const handleSelectAllClick = () => {
    if (!onChange) return;
    if (selectAllCandidateValues.length === 0) return;

    if (isAllSelected) {
      const removeSet = new Set(selectAllCandidateValues);
      onChange(value.filter(v => !removeSet.has(v)));
      return;
    }

    const next = new Set(value);
    selectAllCandidateValues.forEach(v => next.add(v));
    onChange([...next]);
  };

  const handleListScroll = event => {
    if (!onReachListEnd || !hasMore || isFetchingMore) return;

    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    const threshold = 24;
    const isNearBottom = scrollTop + clientHeight >= scrollHeight - threshold;

    if (isNearBottom) {
      onReachListEnd();
    }
  };

  const showCenteredLoader = filteredOptions.length === 0 && (isInitialLoading || (isFetching && !isFetchingMore));
  const showBottomLoader = filteredOptions.length > 0 && isFetchingMore;

  return (
    <div ref={dropdownRef} className="relative w-full">
      <button
        className={`
          flex items-center justify-center gap-2 bg-steel-850 hover:bg-steel-850/70 text-white/60 px-4 py-2 rounded-lg transition-colors w-full border border-steel-750
          ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          ${className}
        `}
        type="button"
        onClick={toggleDropdown}
        disabled={isDisabled}
      >
        <div className="flex flex-wrap gap-1 items-center flex-1 mr-2">
          {selectedOptions.length > 0 ? (
            <span className={selectedOptions.length === 0 ? 'text-white/60' : ''}>
              {selectedOptions.length} Selected
            </span>
          ) : (
            <span className={selectedOptions.length === 0 ? 'text-white/60' : ''}>{placeholder}</span>
          )}
        </div>
        <ChevronDown className={`h-5 w-5 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div
          className={`absolute left-0 z-10 w-full rounded-lg bg-steel-850 shadow-lg border border-steel-750 max-h-80 overflow-hidden flex flex-col ${
            direction === 'up' ? 'bottom-full mb-1' : 'mt-1'
          }`}
        >
          {showSearch && (
            <div className="p-2 border-b border-steel-750" onClick={e => e.stopPropagation()}>
              <LavaSearchInput
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChange={value => {
                  setSearchQuery(value);
                  onSearchChange?.(value);
                }}
                className="!h-9 bg-steel-850 !border-steel-750"
                debounceTime={300}
              />
            </div>
          )}

          <div className="overflow-y-auto max-h-60" onScroll={handleListScroll}>
            {showCenteredLoader ? (
              <div className="px-4 py-6 flex justify-center">
                <Spinner />
              </div>
            ) : filteredOptions.length === 0 ? (
              <div className="px-4 py-3 text-center text-white/60">No assets found</div>
            ) : (
              <>
                {showSelectAll && (
                  <button
                    className="w-full px-4 py-2.5 text-left hover:bg-white/5 flex items-center gap-3 transition-colors border-b border-steel-750/70"
                    type="button"
                    onClick={handleSelectAllClick}
                  >
                    <div
                      className={`w-5 h-5 flex items-center justify-center border rounded ${
                        isAllSelected
                          ? 'border-white bg-white'
                          : isSomeSelected
                            ? 'border-white bg-white/20'
                            : 'border-steel-750 bg-steel-850'
                      }`}
                    >
                      {isAllSelected ? (
                        <Check size={16} strokeWidth={3} className="text-steel-900" />
                      ) : isSomeSelected ? (
                        <div className="w-3 h-0.5 bg-white rounded-full" />
                      ) : null}
                    </div>
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <span className="truncate flex-1" title={selectAllLabel}>
                        {selectAllLabel}
                      </span>
                    </div>
                  </button>
                )}

                {filteredOptions.map(option => {
                  const isSelected = value.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      className="w-full px-4 py-2.5 text-left hover:bg-white/5 flex items-center gap-3 transition-colors"
                      type="button"
                      onClick={() => handleOptionClick(option.value)}
                    >
                      <div
                        className={`w-5 h-5 flex items-center justify-center border ${
                          isSelected ? 'border-white bg-white' : 'border-steel-750 bg-steel-850'
                        } rounded`}
                      >
                        {isSelected && <Check size={16} strokeWidth={3} className="text-steel-900" />}
                      </div>
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="truncate flex-1" title={option.label}>
                          {option.label}
                        </span>
                        {option.secondLabel && (
                          <span
                            className="text-white/40 text-sm ml-auto max-w-[120px] truncate"
                            title={option.secondLabel}
                          >
                            {option.secondLabel}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
                {showBottomLoader && (
                  <div className="px-4 py-2.5 flex justify-center border-t border-steel-750/70 scale-75">
                    <Spinner />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
