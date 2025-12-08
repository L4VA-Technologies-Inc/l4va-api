import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import CardanoWasm, { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from '@/database/vault.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import {
  TransactionBuildResponse,
  TransactionSubmitResponse,
} from '@/modules/vaults/processing-tx/onchain/types/transaction-status.enum';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';

interface NFTListingInput {
  policyId: string;
  assetName: string;
  priceAda: number;
}

interface UnlistInput {
  policyId: string;
  txHashIndex: string; // Format: txHash#outputIndex
}

interface UpdateListingInput {
  policyId: string;
  txHashIndex: string; // Format: txHash#outputIndex
  newPriceAda: number;
}

interface MakeOfferInput {
  policyId: string;
  assetName: string;
  priceAda: number;
}

interface ListingPayload {
  changeAddress: string;
  utxos: string[];
  create: Array<{
    assets: {
      policyId: string;
      assetName: string;
    };
    priceAda: number;
  }>;
}

interface UnlistPayload {
  changeAddress: string;
  utxos: string[];
  unlist: UnlistInput[];
}

interface UpdateListingPayload {
  changeAddress: string;
  utxos: string[];
  update: UpdateListingInput[];
}

interface MakeOfferPayload {
  changeAddress: string;
  utxos: string[];
  createOffer: MakeOfferInput[];
}

@Injectable()
export class WayUpService {
  private readonly logger = new Logger(WayUpService.name);
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly treasuryWalletService: TreasuryWalletService,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
  }

  async listNFTs(vaultId: string, policyIds?: { id: string; priceAda: number }[]): Promise<TransactionBuildResponse> {
    // Get vault and verify treasury wallet exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    if (!vault.treasury_wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    const address = vault.treasury_wallet.treasury_address;
    this.logger.log(`Using treasury wallet address: ${address}`);

    const utxos = await this.blockfrost.addressesUtxosAll(address);

    const filtered = utxos
      .map(u => ({
        ...u,
        amount: u.amount.filter(a => a.unit !== 'lovelace' && policyIds?.some(p => p.id === a.unit.slice(0, 56))),
      }))
      .filter(u => u.amount.length > 0);

    if (filtered.length === 0) {
      throw new Error('No matching assets found');
    }

    const serializedUtxos: string[] = filtered.map(u => {
      const value = CardanoWasm.Value.new(
        CardanoWasm.BigNum.from_str(u.amount.find(a => a.unit === 'lovelace')?.quantity || '0')
      );

      const multiAsset = CardanoWasm.MultiAsset.new();
      u.amount.forEach(a => {
        if (a.unit !== 'lovelace') {
          const policyId = CardanoWasm.ScriptHash.from_bytes(Buffer.from(a.unit.slice(0, 56), 'hex'));
          const assetsMap = CardanoWasm.Assets.new();
          assetsMap.insert(
            CardanoWasm.AssetName.new(Buffer.from(a.unit.slice(56), 'hex')),
            CardanoWasm.BigNum.from_str(a.quantity)
          );
          multiAsset.insert(policyId, assetsMap);
        }
      });
      value.set_multiasset(multiAsset);

      const txOut = CardanoWasm.TransactionOutput.new(CardanoWasm.Address.from_bech32(u.address), value);

      const txUtxo = CardanoWasm.TransactionUnspentOutput.new(
        CardanoWasm.TransactionInput.new(
          CardanoWasm.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex')),
          u.output_index
        ),
        txOut
      );

      return Buffer.from(txUtxo.to_bytes()).toString('hex');
    });

    const create = filtered
      .flatMap(u => u.amount)
      .reduce<{ assets: { policyId: string; assetName: string }; priceAda: number }[]>((acc, a) => {
        const exists = acc.find(
          x => x.assets.policyId === a.unit.slice(0, 56) && x.assets.assetName === a.unit.slice(56)
        );
        if (!exists) {
          const priceObj = policyIds?.find(p => p.id === a.unit.slice(0, 56));
          if (priceObj) {
            acc.push({
              assets: {
                policyId: a.unit.slice(0, 56),
                assetName: a.unit.slice(56),
              },
              priceAda: priceObj.priceAda, // minimum 5 ADA,
            });
          }
        }
        return acc;
      }, []);

    const input = {
      changeAddress: address,
      utxos: serializedUtxos,
      create,
    };

    this.logger.log(`Building WayUp transaction for vault ${vaultId}`);
    this.logger.log(`Treasury address: ${address}`);
    this.logger.log(`UTXOs count: ${serializedUtxos.length}`);
    this.logger.log(`Assets to list: ${JSON.stringify(input.create)}`);

    try {
      // Use BlockchainService to build the transaction
      const buildResponse = await this.blockchainService.buildWayUpTransaction(input);

      this.logger.log(`WayUp transaction built successfully for vault ${vaultId}`);
      return buildResponse;
    } catch (e) {
      this.logger.error(`Failed to build WayUp transaction for vault ${vaultId}`, e);
      throw new Error(`Failed to build WayUp transaction: ${e.message}`);
    }
  }

  /**
   * List NFTs for sale on WayUp Marketplace
   * Builds, signs, and submits the listing transaction
   *
   * @param vaultId - The vault ID that owns the NFTs
   * @param listings - Array of NFTs to list with their prices
   * @returns Transaction hash of the submitted listing
   */
  async createListing(
    vaultId: string,
    listings: NFTListingInput[]
  ): Promise<{ txHash: string; listedAssets: NFTListingInput[] }> {
    this.logger.log(`Creating NFT listing for vault ${vaultId}`);

    // Validate minimum price (5 ADA minimum per WayUp requirements)
    const MIN_PRICE_ADA = 5;
    const invalidPrices = listings.filter(l => l.priceAda < MIN_PRICE_ADA);
    if (invalidPrices.length > 0) {
      throw new Error(`All listings must have a minimum price of ${MIN_PRICE_ADA} ADA`);
    }

    // Get vault and verify treasury wallet exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    if (!vault.treasury_wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    const address = vault.treasury_wallet.treasury_address;
    this.logger.log(`Using treasury wallet address: ${address}`);

    // Get UTXOs containing the NFTs to list
    const utxos = await this.blockfrost.addressesUtxosAll(address);

    // Filter UTXOs that contain the NFTs we want to list
    const filteredUtxos = utxos
      .map(u => ({
        ...u,
        amount: u.amount.filter(
          a =>
            a.unit !== 'lovelace' &&
            listings.some(l => a.unit === l.policyId + l.assetName || a.unit.startsWith(l.policyId))
        ),
      }))
      .filter(u => u.amount.length > 0);

    if (filteredUtxos.length === 0) {
      throw new Error('No UTXOs found containing the NFTs to list');
    }

    // Serialize UTXOs
    const serializedUtxos: string[] = filteredUtxos.map(u => {
      const value = CardanoWasm.Value.new(
        CardanoWasm.BigNum.from_str(u.amount.find(a => a.unit === 'lovelace')?.quantity || '0')
      );

      const multiAsset = CardanoWasm.MultiAsset.new();
      u.amount.forEach(a => {
        if (a.unit !== 'lovelace') {
          const policyId = CardanoWasm.ScriptHash.from_bytes(Buffer.from(a.unit.slice(0, 56), 'hex'));
          const assetsMap = CardanoWasm.Assets.new();
          assetsMap.insert(
            CardanoWasm.AssetName.new(Buffer.from(a.unit.slice(56), 'hex')),
            CardanoWasm.BigNum.from_str(a.quantity)
          );
          multiAsset.insert(policyId, assetsMap);
        }
      });
      value.set_multiasset(multiAsset);

      const txOut = CardanoWasm.TransactionOutput.new(CardanoWasm.Address.from_bech32(u.address), value);

      const txUtxo = CardanoWasm.TransactionUnspentOutput.new(
        CardanoWasm.TransactionInput.new(
          CardanoWasm.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex')),
          u.output_index
        ),
        txOut
      );

      return Buffer.from(txUtxo.to_bytes()).toString('hex');
    });

    // Create listing payload
    const listingPayload: ListingPayload = {
      changeAddress: address,
      utxos: serializedUtxos,
      create: listings.map(listing => ({
        assets: {
          policyId: listing.policyId,
          assetName: listing.assetName,
        },
        priceAda: listing.priceAda,
      })),
    };

    this.logger.log(`Building listing transaction for ${listings.length} NFT(s)`);
    this.logger.log(`Listings: ${JSON.stringify(listings)}`);

    // Build the transaction
    const buildResponse = await this.blockchainService.buildWayUpTransaction(listingPayload);

    if (!buildResponse.complete) {
      throw new Error('Failed to build listing transaction');
    }

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing listing transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.complete);

    // Submit the transaction
    this.logger.log('Submitting listing transaction to blockchain');
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: signedTx,
    });

    this.logger.log(`NFT listing created successfully. TxHash: ${submitResponse.txHash}`);

    return {
      txHash: submitResponse.txHash,
      listedAssets: listings,
    };
  }

  /**
   * Sign a transaction using the vault's treasury wallet private key
   *
   * @param vaultId - The vault ID
   * @param txHex - Transaction hex to sign
   * @returns Signed transaction hex
   */
  private async signTransaction(vaultId: string, txHex: string): Promise<string> {
    try {
      // Get the decrypted private key from treasury wallet
      const privateKey = await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);

      // Deserialize and sign the transaction using FixedTransaction
      const txToSign = FixedTransaction.from_bytes(Buffer.from(txHex, 'hex'));
      txToSign.sign_and_add_vkey_signature(privateKey);

      // Return the signed transaction as hex
      return Buffer.from(txToSign.to_bytes()).toString('hex');
    } catch (error) {
      this.logger.error(`Failed to sign transaction for vault ${vaultId}`, error);
      throw new Error(`Failed to sign transaction: ${error.message}`);
    }
  }

  /**
   * Submit a pre-signed transaction to WayUp marketplace
   *
   * @param signedTxHex - Signed transaction hex
   * @returns Transaction submission response
   */
  async submitTransaction(signedTxHex: string): Promise<TransactionSubmitResponse> {
    try {
      this.logger.log('Submitting signed transaction to blockchain');

      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: signedTxHex,
      });

      this.logger.log(`Transaction submitted successfully: ${submitResponse.txHash}`);
      return submitResponse;
    } catch (error) {
      this.logger.error('Failed to submit transaction', error);
      throw new Error(`Failed to submit transaction: ${error.message}`);
    }
  }

  /**
   * Unlist NFTs from WayUp Marketplace
   * Builds, signs, and submits the unlist transaction to return NFTs to the vault's treasury wallet
   *
   * @param vaultId - The vault ID that owns the listings
   * @param unlistings - Array of listings to remove (policyId and txHashIndex)
   * @returns Transaction hash of the submitted unlist transaction
   */
  async unlistNFTs(
    vaultId: string,
    unlistings: UnlistInput[]
  ): Promise<{ txHash: string; unlistedAssets: UnlistInput[] }> {
    this.logger.log(`Unlisting ${unlistings.length} NFT(s) for vault ${vaultId}`);

    // Get vault and verify treasury wallet exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    if (!vault.treasury_wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    const address = vault.treasury_wallet.treasury_address;
    this.logger.log(`Using treasury wallet address: ${address}`);

    // Get UTXOs to fund the unlist transaction
    const utxos = await this.blockfrost.addressesUtxosAll(address);

    if (utxos.length === 0) {
      throw new Error('No UTXOs available in treasury wallet to fund unlist transaction');
    }

    // Serialize UTXOs for transaction building
    const serializedUtxos: string[] = utxos.slice(0, 10).map(u => {
      const value = CardanoWasm.Value.new(
        CardanoWasm.BigNum.from_str(u.amount.find(a => a.unit === 'lovelace')?.quantity || '0')
      );

      const multiAsset = CardanoWasm.MultiAsset.new();
      u.amount.forEach(a => {
        if (a.unit !== 'lovelace') {
          const policyId = CardanoWasm.ScriptHash.from_bytes(Buffer.from(a.unit.slice(0, 56), 'hex'));
          const assetsMap = CardanoWasm.Assets.new();
          assetsMap.insert(
            CardanoWasm.AssetName.new(Buffer.from(a.unit.slice(56), 'hex')),
            CardanoWasm.BigNum.from_str(a.quantity)
          );
          multiAsset.insert(policyId, assetsMap);
        }
      });

      if (multiAsset.len() > 0) {
        value.set_multiasset(multiAsset);
      }

      const txOut = CardanoWasm.TransactionOutput.new(CardanoWasm.Address.from_bech32(u.address), value);

      const txUtxo = CardanoWasm.TransactionUnspentOutput.new(
        CardanoWasm.TransactionInput.new(
          CardanoWasm.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex')),
          u.output_index
        ),
        txOut
      );

      return Buffer.from(txUtxo.to_bytes()).toString('hex');
    });

    // Create unlist payload
    const unlistPayload: UnlistPayload = {
      changeAddress: address,
      utxos: serializedUtxos,
      unlist: unlistings,
    };

    this.logger.log(`Building unlist transaction for ${unlistings.length} listing(s)`);
    this.logger.log(`Unlistings: ${JSON.stringify(unlistings)}`);

    // Build the transaction
    const buildResponse = await this.blockchainService.buildWayUpTransaction(unlistPayload);

    if (!buildResponse.complete) {
      throw new Error('Failed to build unlist transaction');
    }

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing unlist transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.complete);

    // Submit the transaction
    this.logger.log('Submitting unlist transaction to blockchain');
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: signedTx,
    });

    this.logger.log(`NFT unlisting completed successfully. TxHash: ${submitResponse.txHash}`);
    this.logger.log(`${unlistings.length} NFT(s) returned to treasury wallet: ${address}`);

    return {
      txHash: submitResponse.txHash,
      unlistedAssets: unlistings,
    };
  }

  /**
   * Update NFT listing price on WayUp Marketplace
   * Builds, signs, and submits the update transaction to change the listing price
   *
   * @param vaultId - The vault ID that owns the listings
   * @param updates - Array of listings to update with new prices
   * @returns Transaction hash of the submitted update transaction
   */
  async updateListing(
    vaultId: string,
    updates: UpdateListingInput[]
  ): Promise<{ txHash: string; updatedAssets: UpdateListingInput[] }> {
    this.logger.log(`Updating ${updates.length} NFT listing(s) for vault ${vaultId}`);

    // Validate minimum price (5 ADA minimum per WayUp requirements)
    const MIN_PRICE_ADA = 5;
    const invalidPrices = updates.filter(u => u.newPriceAda < MIN_PRICE_ADA);
    if (invalidPrices.length > 0) {
      throw new Error(`All updated listings must have a minimum price of ${MIN_PRICE_ADA} ADA`);
    }

    // Get vault and verify treasury wallet exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    if (!vault.treasury_wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    const address = vault.treasury_wallet.treasury_address;
    this.logger.log(`Using treasury wallet address: ${address}`);

    // Get UTXOs to fund the update transaction
    const utxos = await this.blockfrost.addressesUtxosAll(address);

    if (utxos.length === 0) {
      throw new Error('No UTXOs available in treasury wallet to fund update transaction');
    }

    // Serialize UTXOs for transaction building
    const serializedUtxos: string[] = utxos.slice(0, 10).map(u => {
      const value = CardanoWasm.Value.new(
        CardanoWasm.BigNum.from_str(u.amount.find(a => a.unit === 'lovelace')?.quantity || '0')
      );

      const multiAsset = CardanoWasm.MultiAsset.new();
      u.amount.forEach(a => {
        if (a.unit !== 'lovelace') {
          const policyId = CardanoWasm.ScriptHash.from_bytes(Buffer.from(a.unit.slice(0, 56), 'hex'));
          const assetsMap = CardanoWasm.Assets.new();
          assetsMap.insert(
            CardanoWasm.AssetName.new(Buffer.from(a.unit.slice(56), 'hex')),
            CardanoWasm.BigNum.from_str(a.quantity)
          );
          multiAsset.insert(policyId, assetsMap);
        }
      });

      if (multiAsset.len() > 0) {
        value.set_multiasset(multiAsset);
      }

      const txOut = CardanoWasm.TransactionOutput.new(CardanoWasm.Address.from_bech32(u.address), value);

      const txUtxo = CardanoWasm.TransactionUnspentOutput.new(
        CardanoWasm.TransactionInput.new(
          CardanoWasm.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex')),
          u.output_index
        ),
        txOut
      );

      return Buffer.from(txUtxo.to_bytes()).toString('hex');
    });

    // Create update payload
    const updatePayload: UpdateListingPayload = {
      changeAddress: address,
      utxos: serializedUtxos,
      update: updates,
    };

    this.logger.log(`Building update transaction for ${updates.length} listing(s)`);
    this.logger.log(`Updates: ${JSON.stringify(updates)}`);

    // Build the transaction
    const buildResponse = await this.blockchainService.buildWayUpTransaction(updatePayload);

    if (!buildResponse.complete) {
      throw new Error('Failed to build update listing transaction');
    }

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing update listing transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.complete);

    // Submit the transaction
    this.logger.log('Submitting update listing transaction to blockchain');
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: signedTx,
    });

    this.logger.log(`NFT listing update completed successfully. TxHash: ${submitResponse.txHash}`);
    this.logger.log(`${updates.length} listing(s) updated with new prices`);

    return {
      txHash: submitResponse.txHash,
      updatedAssets: updates,
    };
  }

  /**
   * Make an offer (bid) on NFTs in WayUp Marketplace
   * Builds, signs, and submits the offer transaction
   *
   * @param vaultId - The vault ID making the offers
   * @param offers - Array of NFTs to bid on with offer amounts
   * @returns Transaction hash of the submitted offer
   */
  async makeOffer(vaultId: string, offers: MakeOfferInput[]): Promise<{ txHash: string; offers: MakeOfferInput[] }> {
    this.logger.log(`Creating ${offers.length} offer(s) for vault ${vaultId}`);

    // Validate minimum offer (5 ADA minimum per WayUp requirements)
    const MIN_OFFER_ADA = 5;
    const invalidOffers = offers.filter(o => o.priceAda < MIN_OFFER_ADA);
    if (invalidOffers.length > 0) {
      throw new Error(`All offers must be at least ${MIN_OFFER_ADA} ADA`);
    }

    // Get vault and verify treasury wallet exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    if (!vault.treasury_wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    const address = vault.treasury_wallet.treasury_address;
    this.logger.log(`Using treasury wallet address: ${address}`);

    // Get UTXOs to fund the offer transaction
    const utxos = await this.blockfrost.addressesUtxosAll(address);

    if (utxos.length === 0) {
      throw new Error('No UTXOs available in treasury wallet to fund offer transaction');
    }

    // Calculate total ADA needed for all offers
    const totalOfferAda = offers.reduce((sum, offer) => sum + offer.priceAda, 0);
    this.logger.log(`Total ADA needed for offers: ${totalOfferAda} ADA`);

    // Serialize UTXOs for transaction building (take enough to cover offers + fees)
    const serializedUtxos: string[] = utxos.slice(0, 15).map(u => {
      const value = CardanoWasm.Value.new(
        CardanoWasm.BigNum.from_str(u.amount.find(a => a.unit === 'lovelace')?.quantity || '0')
      );

      const multiAsset = CardanoWasm.MultiAsset.new();
      u.amount.forEach(a => {
        if (a.unit !== 'lovelace') {
          const policyId = CardanoWasm.ScriptHash.from_bytes(Buffer.from(a.unit.slice(0, 56), 'hex'));
          const assetsMap = CardanoWasm.Assets.new();
          assetsMap.insert(
            CardanoWasm.AssetName.new(Buffer.from(a.unit.slice(56), 'hex')),
            CardanoWasm.BigNum.from_str(a.quantity)
          );
          multiAsset.insert(policyId, assetsMap);
        }
      });

      if (multiAsset.len() > 0) {
        value.set_multiasset(multiAsset);
      }

      const txOut = CardanoWasm.TransactionOutput.new(CardanoWasm.Address.from_bech32(u.address), value);

      const txUtxo = CardanoWasm.TransactionUnspentOutput.new(
        CardanoWasm.TransactionInput.new(
          CardanoWasm.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex')),
          u.output_index
        ),
        txOut
      );

      return Buffer.from(txUtxo.to_bytes()).toString('hex');
    });

    // Create offer payload
    const offerPayload: MakeOfferPayload = {
      changeAddress: address,
      utxos: serializedUtxos,
      createOffer: offers,
    };

    this.logger.log(`Building offer transaction for ${offers.length} NFT(s)`);
    this.logger.log(`Offers: ${JSON.stringify(offers)}`);

    // Build the transaction
    const buildResponse = await this.blockchainService.buildWayUpTransaction(offerPayload);

    if (!buildResponse.complete) {
      throw new Error('Failed to build offer transaction');
    }

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing offer transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.complete);

    // Submit the transaction
    this.logger.log('Submitting offer transaction to blockchain');
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: signedTx,
    });

    this.logger.log(`Offer(s) created successfully. TxHash: ${submitResponse.txHash}`);
    this.logger.log(`${offers.length} offer(s) submitted for NFTs`);

    return {
      txHash: submitResponse.txHash,
      offers: offers,
    };
  }
}
