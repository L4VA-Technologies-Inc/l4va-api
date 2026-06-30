# FT Pricing Strategy Module

Flexible fungible token pricing system with configurable sources and policy-specific routing.

## Architecture

```
pricing-strategy/
├── ft-pricing-strategy.service.ts   # Core routing logic
├── ft-pricing-strategy.controller.ts # Admin REST API
├── ft-pricing-strategy.module.ts     # NestJS module
└── README.md                          # This file
```

## Features

- **5 Pricing Sources:** VYFI, DEXHUNTER, CHARLI3, NEXUS, AUTO
- **Global Default:** Configured via `FT_PRICING_DEFAULT_SOURCE` env var
- **Policy Overrides:** Per-policy source selection via admin API
- **Runtime Config:** No restart needed for rule changes
- **Batch Optimization:** Groups tokens by source for efficiency
- **Deviation Protection:** Integrated with 500% threshold checks

## Quick Start

### 1. Set Default Source (Optional)

```bash
# .env
FT_PRICING_DEFAULT_SOURCE=auto  # default if not specified
```

### 2. Add Policy Rule

```bash
curl -X POST http://localhost:3000/admin/ft-pricing-strategy/rules \
  -H "Content-Type: application/json" \
  -d '{
    "policyId": "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61",
    "source": "CHARLI3",
    "description": "VLRM - use Charli3 for stable pricing"
  }'
```

### 3. Test Token Price

```bash
curl -X POST http://localhost:3000/admin/ft-pricing-strategy/test \
  -H "Content-Type: application/json" \
  -d '{"tokenUnit": "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61446a65644d6963726f55534400"}'
```

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/config` | View current configuration |
| GET | `/rules` | List all policy rules |
| POST | `/rules` | Add/update policy rule |
| PUT | `/rules/:policyId` | Update existing rule |
| DELETE | `/rules/:policyId` | Remove policy rule |
| POST | `/test` | Test single token pricing |
| POST | `/test-batch` | Test batch pricing |

All endpoints require admin authentication.

## Integration

Automatically used by:
- `TaptoolsService.getAssetValue()` - All asset valuations
- `TaptoolsService.updateAssetPrices()` - Database updates
- LP token pricing - Liquidity pool valuations
- Vault TVL calculations - All vault totals

## Pricing Flow

```
getTokenPrice(tokenUnit)
  ↓
Extract policyId from tokenUnit
  ↓
Check policy rules map
  ↓
Has rule? → Use rule.source
No rule?  → Use defaultSource
  ↓
Route to pricing client:
  - VYFI → DexHunterPricingService (VyFi cache)
  - DEXHUNTER → DexHunterPricingService (API)
  - CHARLI3 → Charli3Client
  - NEXUS → NexusClient
  - AUTO → VyFi cache → DexHunter → Charli3
  ↓
Return price or null
```

## Batch Optimization

When calling `getTokenPrices(tokenUnits[])`:

1. Group tokens by pricing source
2. Fetch each group in parallel
3. Merge results into single Map
4. Return combined prices

This minimizes API calls and improves performance.

## Documentation

See [FT_PRICING_STRATEGY_GUIDE.md](../../FT_PRICING_STRATEGY_GUIDE.md) for comprehensive documentation.

See [FT_PRICING_STRATEGY_IMPLEMENTATION.md](../../FT_PRICING_STRATEGY_IMPLEMENTATION.md) for implementation details.
