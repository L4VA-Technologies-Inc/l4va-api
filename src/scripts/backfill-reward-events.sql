-- =============================================================================
-- Backfill: insert all historical reward-eligible events into events.outbox
-- Safe to run multiple times — ON CONFLICT DO NOTHING skips existing entries.
--
-- Events inserted:
--   ASSET_CONTRIBUTION   (all confirmed contributions)
--   TOKEN_ACQUIRE        (all confirmed acquisitions)
--   GOVERNANCE_PROPOSAL  (active/passed/executed)
--   GOVERNANCE_VOTE      (all votes)
-- =============================================================================

-- -----------------------------------------------------------------------
-- 1. ASSET_CONTRIBUTION
--    One event per confirmed contribute transaction.
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
GROUP BY t.id, t.tx_hash, t.vault_id, u.address
ON CONFLICT (idempotency_key) DO NOTHING;


-- -----------------------------------------------------------------------
-- 2. TOKEN_ACQUIRE
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
-- 3. GOVERNANCE_PROPOSAL
--    One event per active/passed/executed proposal.
--    Idempotency key:
--      Paid proposals (metadata has paymentTxHash):
--        "GOVERNANCE_PROPOSAL:{txHash}"  — same as live producer, no dup.
--      Free proposals (no paymentTxHash):
--        "GOVERNANCE_PROPOSAL:proposal:{id}" — backfill-only key.
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
  CASE WHEN p.metadata->>'paymentTxHash' IS NOT NULL
    THEN 'governance_proposal:' || (p.metadata->>'paymentTxHash')
    ELSE 'governance_proposal:proposal:' || p.id
  END,
  'pending',
  p.created_at
FROM proposal p
JOIN users u ON u.id = p.creator_id
WHERE p.status IN ('active', 'passed', 'executed')
ON CONFLICT (idempotency_key) DO NOTHING;


-- -----------------------------------------------------------------------
-- 4. GOVERNANCE_VOTE
--    One event per vote.
--    Key: "GOVERNANCE_VOTE:vote:{vote.id}"
--    (The live producer emits votes without an idempotency key, so
--    backfill keys are guaranteed not to collide with live entries.)
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
  'governance_vote:vote:' || v.id,
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
  'expansion_token_purchase',
  'governance_proposal',
  'governance_vote'
)
GROUP BY event_type
ORDER BY event_type;
