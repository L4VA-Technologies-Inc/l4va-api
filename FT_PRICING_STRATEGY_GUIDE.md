# FT Pricing Strategy System

## Overview

The new FT (Fungible Token) Pricing Strategy system allows flexible configuration of pricing API sources for tokens. You can:

1. **Set a global default source** for all FT pricing
2. **Override specific policies** to use different sources
3. **Switch sources at runtime** without code changes or restarts

## Pricing Sources

- **VYFI** - VyFi bulk pricing with Redis cache (10-minute refresh)
- **DEXHUNTER** - Direct DexHunter API calls
- **CHARLI3** - Aggregate pricing from Charli3 (covers 14,000+ pools)
- **NEXUS** - Nexus pool-based pricing
- **AUTO** (default) - Smart fallback: VyFi cache → DexHunter → Charli3

## Configuration

### Environment Variable

Set the default pricing source in your `.env` file:

```bash
# Default pricing source: auto, vyfi, dexhunter, charli3, nexus
FT_PRICING_DEFAULT_SOURCE=auto
```

If not set, defaults to `auto` (VyFi-first with fallback).

### Policy-Specific Rules

Override the default for specific token policies using the admin API endpoints.

## Admin API Endpoints

All endpoints require admin authentication and are prefixed with `/admin/ft-pricing-strategy`.

### 1. Get Current Configuration

```http
GET /admin/ft-pricing-strategy/config
```

**Response:**
```json
{
  "defaultSource": "auto",
  "policyRulesCount": 2,
  "policyRules": [
    {
      "policyId": "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61",
      "source": "CHARLI3",
      "description": "VLRM token - use Charli3 for more stable pricing"
    },
    {
      "policyId": "29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6",
      "source": "VYFI",
      "poolId": "minswap",
      "description": "MIN token - always use VyFi"
    }
  ]
}
```

### 2. List All Policy Rules

```http
GET /admin/ft-pricing-strategy/rules
```

### 3. Add or Update a Policy Rule

```http
POST /admin/ft-pricing-strategy/rules
Content-Type: application/json

{
  "policyId": "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61",
  "source": "CHARLI3",
  "description": "VLRM token - use Charli3 for stability"
}
```

**Optional fields:**
- `poolId` - Specific pool ID for pool-based pricing
- `description` - Human-readable note about why this rule exists

### 4. Update an Existing Rule

```http
PUT /admin/ft-pricing-strategy/rules/:policyId
Content-Type: application/json

{
  "source": "DEXHUNTER",
  "description": "Switched to DexHunter for better coverage"
}
```

### 5. Delete a Policy Rule

```http
DELETE /admin/ft-pricing-strategy/rules/:policyId
```

Removes the rule. Token will fall back to default source.

### 6. Test Single Token Pricing

```http
POST /admin/ft-pricing-strategy/test
Content-Type: application/json

{
  "tokenUnit": "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61446a65644d6963726f55534400"
}
```

**Response:**
```json
{
  "tokenUnit": "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61446a65644d6963726f55534400",
  "policyId": "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61",
  "price": 0.0156,
  "priceUnavailable": false,
  "usedPolicyRule": true,
  "policyRule": {
    "policyId": "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61",
    "source": "CHARLI3",
    "description": "VLRM token - use Charli3 for stability"
  },
  "defaultSource": "auto"
}
```

### 7. Test Batch Pricing

```http
POST /admin/ft-pricing-strategy/test-batch
Content-Type: application/json

{
  "tokenUnits": [
    "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61446a65644d6963726f55534400",
    "29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6000643b04d494e"
  ]
}
```

## Use Cases

### Switch Global Source When API is Down

If VyFi pricing becomes unreliable:

```bash
# Update .env
FT_PRICING_DEFAULT_SOURCE=charli3

# Restart the service
pm2 restart l4va-api
```

Or add policy rules via API to switch specific tokens without restart.

### Pin Critical Tokens to Specific Sources

For tokens that need stable pricing:

```bash
curl -X POST http://localhost:3000/admin/ft-pricing-strategy/rules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{
    "policyId": "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61",
    "source": "CHARLI3",
    "description": "VLRM - use Charli3 aggregate pricing"
  }'
```

### Use VyFi-Specific Pricing for VyFi Tokens

```bash
curl -X POST http://localhost:3000/admin/ft-pricing-strategy/rules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{
    "policyId": "33d50e03229f0f8c445c78941e4c2f6f84c05945d6169e5b8a789dec",
    "source": "VYFI",
    "poolId": "vyfi",
    "description": "VYFI token - use their own API"
  }'
```

## Integration

The FT pricing strategy is automatically integrated into:

- **TaptoolsService.getAssetValue()** - All asset valuations
- **TaptoolsService.updateAssetPrices()** - Database price updates
- **LP token pricing** - Liquidity pool token valuations
- **Vault TVL calculations** - All vault total value calculations

All FT pricing now respects:
1. Policy-specific rules (if configured)
2. Global default source (from env var)
3. Price deviation protection (500% threshold)

## Architecture

### Service Layer

- **FTPricingStrategyService** - Main routing service
  - Routes requests to correct pricing client
  - Manages policy rule map (in-memory)
  - Batches requests by source for efficiency
  
- **DexHunterPricingService** - VyFi + DexHunter fallback
- **Charli3Client** - Aggregate pricing
- **TapToolsClient** - Legacy wrapper
- **NexusClient** - Pool-based pricing

### Controller Layer

- **FTPricingStrategyController** - Admin API for rule management

### Module Registration

```typescript
// taptools.module.ts
imports: [
  DexHunterPricingModule,
  FTPricingStrategyModule,  // ✅ New pricing strategy
  TapToolsPricingModule,
  // ...
]
```

## Price Deviation Protection

All pricing paths (including the new strategy) include 500% deviation protection:

1. Fetches cached database price
2. Fetches fresh API price
3. Compares prices using `shouldAcceptPriceUpdate()`
4. On rejection: uses cached price or returns 0
5. Logs manual review alerts

This prevents price manipulation attacks and API data errors.

## Future Enhancements

### Database Persistence for Rules

Currently, policy rules are stored in-memory (lost on restart). To persist:

1. Create `PolicyPricingRule` entity
2. Load rules from database on service init
3. Save rule changes to database
4. Keep in-memory Map for fast lookups

### WebSocket Price Updates

For real-time price updates, consider:

1. WebSocket connections to pricing APIs
2. Push updates to connected clients
3. Update Redis cache on WebSocket events

### Price Quality Metrics

Track pricing source reliability:

1. Record success/failure rates per source
2. Track price staleness
3. Auto-switch sources if quality degrades
4. Alert admins when sources fail

## Troubleshooting

### Token Price Always Returns Null

Check:
1. Policy rule configured correctly
2. Source API is available
3. Token exists in source's database
4. Redis cache is working (for VyFi)

Use test endpoint to debug:
```http
POST /admin/ft-pricing-strategy/test
{
  "tokenUnit": "YOUR_TOKEN_UNIT"
}
```

### Price Deviation Rejected

If you see "FT price update rejected" errors:

1. Check if price is legitimately wrong (API error)
2. If price is correct but volatile, consider:
   - Adjusting `priceMaxDeviationPercentFt` in SystemSettings
   - Switching to a more stable pricing source for that policy
   
### VyFi Cache Not Refreshing

Check:
1. Redis connection is healthy
2. VyFi API is responding
3. Distributed lock is not stuck (540s TTL)

Logs will show: "VyFi cache refresh complete: N tokens cached"
