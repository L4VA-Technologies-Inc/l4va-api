-- =============================================================================
-- Backfill: insert all historical reward-eligible events into events.outbox
-- Safe to run multiple times — ON CONFLICT DO NOTHING skips existing entries.
--
-- Events inserted:
--   ASSET_CONTRIBUTION   (confirmed contributions outside expansion periods)
--   EXPANSION_ASSET_CONTRIBUTION (confirmed contributions during expansion periods)
--   TOKEN_ACQUIRE        (confirmed token acquisitions)
--   GOVERNANCE_PROPOSAL  (active/passed/executed proposals)
--   GOVERNANCE_VOTE      (all votes)
--
-- Expansion Period Detection:
--   A transaction is considered part of an expansion if:
--     1. An expansion proposal exists for the vault
--     2. The proposal status is 'executed'
--     3. The proposal has an execution_date
--     4. Transaction created_at >= execution_date AND:
--        a) If metadata.expansion.noLimit = true:
--           All transactions from execution_date onwards are expansion
--        b) If metadata.expansion.noLimit = false:
--           Transaction created_at <= execution_date + metadata.expansion.duration
-- =============================================================================

-- -----------------------------------------------------------------------
-- 1. ASSET_CONTRIBUTION (regular vault contributions)
--    One event per confirmed contribute transaction that occurred OUTSIDE expansion periods.
--    units = number of assets in that transaction (NFT/FT count).
-- -----------------------------------------------------------------------
INSERT INTO events.outbox
  (aggregate_id, aggregate_type, event_type, event_data, idempotency_key, status, created_at)
SELECT
  t.vault_id::uuid,
  'vault',
  'asset_contribution',
  jsonb_build_object(
    'wallet_address',  u.address,
    'vault_id',        t.vault_id,
    'tx_hash',         t.tx_hash,
    'units',           COUNT(a.id),
    'event_timestamp', t.created_at
  ),
  'asset_contribution:' || t.tx_hash,
  'pending',
  t.created_at
FROM transactions t
JOIN users  u ON u.id = t.user_id
LEFT JOIN assets a ON a.transaction_id = t.id
WHERE t.status  = 'confirmed'
  AND t.type    = 'contribute'
  AND t.tx_hash IS NOT NULL
  -- Exclude transactions that occurred during expansion periods
  AND NOT EXISTS (
    SELECT 1
    FROM proposal p
    WHERE p.vault_id = t.vault_id
      AND p.proposal_type = 'expansion'
      AND p.status = 'executed'
      AND p.execution_date IS NOT NULL
      AND t.created_at >= p.execution_date
      AND (
        -- If noLimit is true, all transactions from execution_date onwards are expansion
        (p.metadata->'expansion'->>'noLimit')::boolean = true
        OR
        -- If noLimit is false, check within duration window
        (
          (p.metadata->'expansion'->>'noLimit')::boolean = false
          AND t.created_at <= (
            p.execution_date + (
              (p.metadata->'expansion'->>'duration')::bigint * INTERVAL '1 millisecond'
            )
          )
        )
      )
  )
GROUP BY t.id, t.tx_hash, t.vault_id, u.address
ON CONFLICT (idempotency_key) DO NOTHING;


-- -----------------------------------------------------------------------
-- 2. EXPANSION_ASSET_CONTRIBUTION (contributions during expansion periods)
--    One event per confirmed contribute transaction that occurred DURING expansion periods.
--    units = number of assets in that transaction (NFT/FT count).
-- -----------------------------------------------------------------------
INSERT INTO events.outbox
  (aggregate_id, aggregate_type, event_type, event_data, idempotency_key, status, created_at)
SELECT
  t.vault_id::uuid,
  'vault',
  'expansion_asset_contribution',
  jsonb_build_object(
    'wallet_address',  u.address,
    'vault_id',        t.vault_id,
    'tx_hash',         t.tx_hash,
    'units',           COUNT(a.id),
    'event_timestamp', t.created_at
  ),
  'expansion_asset_contribution:' || t.tx_hash,
  'pending',
  t.created_at
FROM transactions t
JOIN users  u ON u.id = t.user_id
LEFT JOIN assets a ON a.transaction_id = t.id
WHERE t.status  = 'confirmed'
  AND t.type    = 'contribute'
  AND t.tx_hash IS NOT NULL
  -- Only include transactions that occurred during expansion periods
  AND EXISTS (
    SELECT 1
    FROM proposal p
    WHERE p.vault_id = t.vault_id
      AND p.proposal_type = 'expansion'
      AND p.status = 'executed'
      AND p.execution_date IS NOT NULL
      AND t.created_at >= p.execution_date
      AND (
        -- If noLimit is true, all transactions from execution_date onwards are expansion
        (p.metadata->'expansion'->>'noLimit')::boolean = true
        OR
        -- If noLimit is false, check within duration window
        (
          (p.metadata->'expansion'->>'noLimit')::boolean = false
          AND t.created_at <= (
            p.execution_date + (
              (p.metadata->'expansion'->>'duration')::bigint * INTERVAL '1 millisecond'
            )
          )
        )
      )
  )
GROUP BY t.id, t.tx_hash, t.vault_id, u.address
ON CONFLICT (idempotency_key) DO NOTHING;


-- -----------------------------------------------------------------------
-- 3. TOKEN_ACQUIRE (all token acquisitions)
--    One event per confirmed acquire transaction.
--    units = transaction.amount (lovelace paid).
-- -----------------------------------------------------------------------
INSERT INTO events.outbox
  (aggregate_id, aggregate_type, event_type, event_data, idempotency_key, status, created_at)
SELECT
  t.vault_id::uuid,
  'vault',
  'token_acquire',
  jsonb_build_object(
    'wallet_address',  u.address,
    'vault_id',        t.vault_id,
    'tx_hash',         t.tx_hash,
    'units',           t.amount,
    'event_timestamp', t.created_at
  ),
  'token_acquire:' || t.tx_hash,
  'pending',
  t.created_at
FROM transactions t
JOIN users  u ON u.id = t.user_id
WHERE t.status  = 'confirmed'
  AND t.type    = 'acquire'
  AND t.tx_hash IS NOT NULL
ON CONFLICT (idempotency_key) DO NOTHING;


-- -----------------------------------------------------------------------
-- 4. GOVERNANCE_PROPOSAL
--    One event per active/passed/executed proposal.
--    Idempotency key: "governance_proposal:{proposal.id}"
--    (Matches live producer pattern to prevent duplicates.)
-- -----------------------------------------------------------------------
INSERT INTO events.outbox
  (aggregate_id, aggregate_type, event_type, event_data, idempotency_key, status, created_at)
SELECT
  p.vault_id::uuid,
  'vault',
  'governance_proposal',
  jsonb_build_object(
    'wallet_address',  u.address,
    'vault_id',        p.vault_id,
    'tx_hash',         p.metadata->>'paymentTxHash',
    'units',           1,
    'proposal_id',     p.id,
    'proposal_type',   p.proposal_type,
    'event_timestamp', p.created_at
  ),
  'governance_proposal:' || p.id,
  'pending',
  p.created_at
FROM proposal p
JOIN users u ON u.id = p.creator_id
WHERE p.status IN ('active', 'passed', 'executed')
ON CONFLICT (idempotency_key) DO NOTHING;


-- -----------------------------------------------------------------------
-- 5. GOVERNANCE_VOTE
--    One event per vote.
--    Idempotency key: "governance_vote:{vote.id}"
--    (Matches live producer pattern to prevent duplicates.)
-- -----------------------------------------------------------------------
INSERT INTO events.outbox
  (aggregate_id, aggregate_type, event_type, event_data, idempotency_key, status, created_at)
SELECT
  p.vault_id::uuid,
  'vault',
  'governance_vote',
  jsonb_build_object(
    'wallet_address',  v.voter_address,
    'vault_id',        p.vault_id,
    'tx_hash',         NULL,
    'units',           1,
    'proposal_id',     v.proposal_id,
    'event_timestamp', v.timestamp
  ),
  'governance_vote:' || v.id,
  'pending',
  v.timestamp
FROM vote v
JOIN proposal p ON p.id = v.proposal_id
ON CONFLICT (idempotency_key) DO NOTHING;


-- -----------------------------------------------------------------------
-- Quick sanity check — run after the inserts to see what landed
-- -----------------------------------------------------------------------
SELECT
  event_type,
  COUNT(*) AS total,
  SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) AS processed
FROM events.outbox
WHERE event_type IN (
  'asset_contribution',
  'token_acquire',
  'expansion_asset_contribution',
  'governance_proposal',
  'governance_vote'
)
GROUP BY event_type
ORDER BY event_type;
