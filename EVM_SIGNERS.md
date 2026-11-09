# EVM (Robinhood) signing keys

The backend signs on Robinhood Chain with two keys. Both live in **Google Cloud KMS** and never leave it:
the backend hashes locally and asks KMS to sign the hash. There is no private key in env, Secret Manager
or on disk.

| Role | Signs | Env vars |
|---|---|---|
| Admin | Vault `authority` transactions (close cycle, refunds, claims, swaps, distributions, pause) and the EIP-712 `creationApprover` signature for new vaults | `EVM_ADMIN_KMS_KEY`, `EVM_ADMIN_ADDRESS` |
| Minting | EIP-712 contribution authorizations (vault `mintingKey`) | `EVM_MINTING_SIGNER_KMS_KEY`, `EVM_MINTING_SIGNER_ADDRESS` |

`*_KMS_KEY` is the full key-version name. `*_ADDRESS` is the address that key must resolve to; the
backend refuses to sign if they differ.

Code: `src/common/evm/kms-account.ts` (viem account over KMS) and
`src/modules/vaults/processing-tx/onchain/evm-kms-signers.service.ts`.

> **Only the KMS signer is ever committed.** Never push code that signs with a raw private key, and
> never put `EVM_ADMIN_PRIVATE_KEY` / `EVM_MINTING_SIGNER_PRIVATE_KEY` into a server secret.

## Keys

Keyring `l4va-evm-signers` in `us-central1` (project `l4va-protocol`), algorithm
`EC_SIGN_SECP256K1_SHA256`, protection level HSM, version 1. The VM service account has
`roles/cloudkms.signerVerifier` on each key, and nothing project-wide.

| Key | Address | Secret |
|---|---|---|
| `mainnet-authority` | `0x3daC60dAA90aD92DcC8B9E0c7aCcA7FC97D13B45` | `mainnet` |
| `mainnet-minting` | `0xD0377e844D24F9a891C427b02dbE867AD49efe72` | `mainnet` |
| `staging-authority` | `0x87417f76EEF4cc4c6aa440e87d357192aEF5f9CA` | `staging` |
| `staging-minting` | `0x8D430A298b8Ce54b82DA4501c3640AA72546d8b2` | `staging` |
| `testnet-authority` | `0x0e329Bc35dB95fb330687bc7d3b2df9F21d6D974` | `testnet` |
| `testnet-minting` | `0xd2A6884cB954ddaA107Cd2b425BA7f1F13082Af5` | `testnet` |

The `*-authority` addresses pay gas and must hold ETH. The `*-minting` keys only sign messages.

Example secret entries (testnet):

```
EVM_ADMIN_KMS_KEY=projects/l4va-protocol/locations/us-central1/keyRings/l4va-evm-signers/cryptoKeys/testnet-authority/cryptoKeyVersions/1
EVM_ADMIN_ADDRESS=0x0e329Bc35dB95fb330687bc7d3b2df9F21d6D974
EVM_MINTING_SIGNER_KMS_KEY=projects/l4va-protocol/locations/us-central1/keyRings/l4va-evm-signers/cryptoKeys/testnet-minting/cryptoKeyVersions/1
EVM_MINTING_SIGNER_ADDRESS=0xd2A6884cB954ddaA107Cd2b425BA7f1F13082Af5
```

On startup the logs show `KMS vault authority and creation approver ready: 0x…` and
`KMS contribution minting key ready: 0x…`. If a key cannot be loaded the API still starts, but every
EVM signature fails until it is fixed.

### Address of a KMS key

Run from this repository (it needs `viem`):

```bash
gcloud kms keys versions get-public-key 1 --key=<key> --keyring=l4va-evm-signers \
  --location=us-central1 --project=l4va-protocol --output-file=- \
  | node -e "const{publicKeyToAddress}=require('viem/accounts');const p=require('fs').readFileSync(0,'utf8');const d=Buffer.from(p.replace(/-----[^-]+-----/g,'').replace(/\s/g,''),'base64');console.log(publicKeyToAddress('0x'+d.subarray(-65).toString('hex')))"
```

### Rotating a key

A new key version is a **new address**. Vaults keep the old `authority` until it is moved with
`proposeAuthority(new)` from the old key and `acceptAuthority()` from the new one. A vault's
`mintingKey` is fixed at creation and cannot be moved. Plan rotations, don't do them casually.

## Local development

KMS is the only signer in the code. To sign locally, use one of these.

### Option A: a KMS dev key (recommended)

Nothing to change in code.

1. An owner creates a dev key once (`dev-authority`, `dev-minting`, same settings as above) and grants
   your Google account `roles/cloudkms.signerVerifier` on it.
2. Log in so the KMS client can use your account:
   ```bash
   gcloud auth application-default login
   ```
3. In your local `.env`, set `EVM_CHAIN_ID=46630` (testnet) and the four `EVM_*` vars for the dev keys.
4. Fund `dev-authority` from the testnet faucet.

### Option B: a local private key (local only, never commit)

Use a **fresh testnet-only key** made for this (`cast wallet new`), funded from the faucet. Never use a
key that has been in any server secret.

1. In your local `.env`:
   ```
   EVM_CHAIN_ID=46630
   EVM_ADMIN_ADDRESS=<address of your dev key>
   EVM_ADMIN_PRIVATE_KEY=<your dev key>
   EVM_MINTING_SIGNER_ADDRESS=<address of your dev key>
   EVM_MINTING_SIGNER_PRIVATE_KEY=<your dev key>
   ```
2. Patch `load()` in `src/modules/vaults/processing-tx/onchain/evm-kms-signers.service.ts`
   **locally**:
   ```ts
   // LOCAL ONLY — DO NOT COMMIT
   private async load(role: Role): Promise<LocalAccount> {
     const env = role === 'admin' ? 'EVM_ADMIN_PRIVATE_KEY' : 'EVM_MINTING_SIGNER_PRIVATE_KEY';
     return privateKeyToAccount(this.configService.get<string>(env) as `0x${string}`);
   }
   ```
   with `import { privateKeyToAccount } from 'viem/accounts';`.
3. Before every commit, make sure the patch is not staged:
   ```bash
   git diff --cached -- src/modules/vaults/processing-tx/onchain/evm-kms-signers.service.ts
   ```
   Keep it out of the index with `git update-index --skip-worktree <file>` (undo with
   `--no-skip-worktree` before pulling changes to that file), or `git stash` it before committing.
