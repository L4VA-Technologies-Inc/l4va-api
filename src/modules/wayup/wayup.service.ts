import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  Address,
  FixedTransaction,
  TransactionHash,
  TransactionInput,
  TransactionOutput,
  TransactionUnspentOutput,
  Value,
  BigNum,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  BuyNFTInput,
  BuyNFTPayload,
  CombinedMarketplaceActionsInput,
  ListingPayload,
  MakeOfferInput,
  MakeOfferPayload,
  NFTListingInput,
  UnlistInput,
  UnlistPayload,
  UpdateListingInput,
  UpdateListingPayload,
  WayUpTransactionInput,
} from './wayup.types';

import { Vault } from '@/database/vault.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';

@Injectable()
export class WayUpService {
  private readonly logger = new Logger(WayUpService.name);
  private readonly blockfrost: BlockFrostAPI;

  private readonly MIN_PRICE_ADA = 5; // Validate minimum price (5 ADA minimum per WayUp requirements)

  constructor(
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly treasuryWalletService: TreasuryWalletService,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
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
    const invalidPrices = listings.filter(l => l.priceAda < this.MIN_PRICE_ADA);
    if (invalidPrices.length > 0) {
      throw new Error(`All listings must have a minimum price of ${this.MIN_PRICE_ADA} ADA`);
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

    // Collect target NFTs to list
    const targetAssets = listings.map(listing => ({
      token: listing.policyId + listing.assetName,
      amount: 1,
    }));

    // Get UTXOs containing the NFTs using getUtxosExtract
    const { utxos: serializedUtxos, requiredInputs } = await getUtxosExtract(
      Address.from_bech32(address),
      this.blockfrost,
      {
        targetAssets,
        minAda: 1000000,
        maxUtxos: 20,
      }
    );

    if (!requiredInputs || requiredInputs.length === 0) {
      throw new Error('No UTXOs found containing the NFTs to list');
    }

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

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing listing transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.transactions[0]);

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

    // Get UTXOs to fund the unlist transaction - only pure ADA UTXOs
    const allUtxos = await this.blockfrost.addressesUtxosAll(address);

    // Filter to only pure ADA UTXOs (no multiassets)
    const pureAdaUtxos = allUtxos.filter(u => u.amount.length === 1 && u.amount[0].unit === 'lovelace');

    if (pureAdaUtxos.length === 0) {
      throw new Error('No pure ADA UTXOs available in treasury wallet to fund transaction');
    }

    // Serialize UTXOs
    const serializedUtxos = pureAdaUtxos.slice(0, 10).map(u => {
      const value = Value.new(BigNum.from_str(u.amount[0].quantity));
      const txOut = TransactionOutput.new(Address.from_bech32(u.address), value);
      const txUtxo = TransactionUnspentOutput.new(
        TransactionInput.new(TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex')), u.output_index),
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

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing unlist transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.transactions[0]);

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

    const invalidPrices = updates.filter(u => u.newPriceAda < this.MIN_PRICE_ADA);
    if (invalidPrices.length > 0) {
      throw new Error(`All updated listings must have a minimum price of ${this.MIN_PRICE_ADA} ADA`);
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

    // Get UTXOs to fund the update transaction - only pure ADA UTXOs
    const allUtxos = await this.blockfrost.addressesUtxosAll(address);

    // Filter to only pure ADA UTXOs (no multiassets)
    const pureAdaUtxos = allUtxos.filter(u => u.amount.length === 1 && u.amount[0].unit === 'lovelace');

    if (pureAdaUtxos.length === 0) {
      throw new Error('No pure ADA UTXOs available in treasury wallet to fund transaction');
    }

    // Serialize UTXOs
    const serializedUtxos = pureAdaUtxos.slice(0, 10).map(u => {
      const value = Value.new(BigNum.from_str(u.amount[0].quantity));
      const txOut = TransactionOutput.new(Address.from_bech32(u.address), value);
      const txUtxo = TransactionUnspentOutput.new(
        TransactionInput.new(TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex')), u.output_index),
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

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing update listing transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.transactions[0]);

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

    // Validate minimum offer (minimum per WayUp requirements)
    const invalidOffers = offers.filter(o => o.priceAda < this.MIN_PRICE_ADA);
    if (invalidOffers.length > 0) {
      throw new Error(`All offers must be at least ${this.MIN_PRICE_ADA} ADA`);
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

    // Calculate total ADA needed for all offers (in lovelace)
    const totalOfferAda = offers.reduce((sum, offer) => sum + offer.priceAda, 0);
    const totalOfferLovelace = totalOfferAda * 1_000_000;
    this.logger.log(`Total ADA needed for offers: ${totalOfferAda} ADA (${totalOfferLovelace} lovelace)`);

    // Get UTXOs to fund the offer transaction using getUtxosExtract with targetAdaAmount
    const { utxos: serializedUtxos, totalAdaCollected } = await getUtxosExtract(
      Address.from_bech32(address),
      this.blockfrost,
      {
        targetAdaAmount: totalOfferLovelace + 5_000_000, // Add 5 ADA buffer for fees
        minAda: 1000000,
        maxUtxos: 15,
      }
    );

    if (serializedUtxos.length === 0) {
      throw new Error('No UTXOs available in treasury wallet to fund offer transaction');
    }

    this.logger.log(`Collected ${totalAdaCollected} lovelace from ${serializedUtxos.length} UTXOs`);

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

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing offer transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.transactions[0]);

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

  /**
   * Buy NFTs from WayUp Marketplace
   * Builds, signs, and submits the purchase transaction
   *
   * @param vaultId - The vault ID making the purchase
   * @param purchases - Array of NFTs to buy with their listing information
   * @returns Transaction hash of the submitted purchase
   */
  async buyNFT(vaultId: string, purchases: BuyNFTInput[]): Promise<{ txHash: string; purchases: BuyNFTInput[] }> {
    this.logger.log(`Buying ${purchases.length} NFT(s) for vault ${vaultId}`);

    const invalidPrices = purchases.filter(p => p.priceAda < this.MIN_PRICE_ADA);
    if (invalidPrices.length > 0) {
      throw new Error(`All NFT purchases must be at least ${this.MIN_PRICE_ADA} ADA`);
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

    // Calculate total ADA needed for all purchases (in lovelace)
    const totalPurchaseAda = purchases.reduce((sum, purchase) => sum + purchase.priceAda, 0);
    const totalPurchaseLovelace = totalPurchaseAda * 1_000_000;
    this.logger.log(`Total ADA needed for purchases: ${totalPurchaseAda} ADA (${totalPurchaseLovelace} lovelace)`);

    // Get UTXOs to fund the purchase transaction using getUtxosExtract with targetAdaAmount
    const { utxos: serializedUtxos, totalAdaCollected } = await getUtxosExtract(
      Address.from_bech32(address),
      this.blockfrost,
      {
        targetAdaAmount: totalPurchaseLovelace + 10_000_000, // Add 10 ADA buffer for fees
        minAda: 1000000,
        maxUtxos: 20,
      }
    );

    if (serializedUtxos.length === 0) {
      throw new Error('No UTXOs available in treasury wallet to fund purchase transaction');
    }

    this.logger.log(`Collected ${totalAdaCollected} lovelace from ${serializedUtxos.length} UTXOs`);

    // Create buy payload
    const buyPayload: BuyNFTPayload = {
      changeAddress: address,
      utxos: serializedUtxos,
      buy: purchases,
    };

    this.logger.log(`Building purchase transaction for ${purchases.length} NFT(s)`);
    this.logger.log(`Purchases: ${JSON.stringify(purchases)}`);

    // Build the transaction
    const buildResponse = await this.blockchainService.buildWayUpTransaction(buyPayload);

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing purchase transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.transactions[0]);

    // Submit the transaction
    this.logger.log('Submitting purchase transaction to blockchain');
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: signedTx,
    });

    this.logger.log(`NFT purchase completed successfully. TxHash: ${submitResponse.txHash}`);
    this.logger.log(`${purchases.length} NFT(s) purchased and sent to treasury wallet: ${address}`);

    return {
      txHash: submitResponse.txHash,
      purchases: purchases,
    };
  }

  /**
   * Execute multiple marketplace actions in a single transaction
   * Combines listings, unlistings, updates, offers, and purchases into one atomic operation
   *
   * @param vaultId - The vault ID executing the actions
   * @param actions - Combined marketplace actions to execute
   * @returns Transaction hash and summary of executed actions
   */
  async executeCombinedMarketplaceActions(
    vaultId: string,
    actions: CombinedMarketplaceActionsInput
  ): Promise<{
    txHash: string;
    summary: {
      listedCount: number;
      unlistedCount: number;
      updatedCount: number;
      offersCount: number;
      purchasedCount: number;
    };
  }> {
    this.logger.log(`Executing combined marketplace actions for vault ${vaultId}`);

    // Validate that at least one action is provided
    const hasActions =
      (actions.listings?.length ?? 0) > 0 ||
      (actions.unlistings?.length ?? 0) > 0 ||
      (actions.updates?.length ?? 0) > 0 ||
      (actions.offers?.length ?? 0) > 0 ||
      (actions.purchases?.length ?? 0) > 0;

    if (!hasActions) {
      throw new Error('At least one marketplace action must be provided');
    }

    // Validate minimum prices for listings
    if (actions.listings?.length > 0) {
      const invalidPrices = actions.listings.filter(l => l.priceAda < this.MIN_PRICE_ADA);
      if (invalidPrices.length > 0) {
        throw new Error(`All listings must have a minimum price of ${this.MIN_PRICE_ADA} ADA`);
      }
    }

    // Validate minimum prices for updates
    if (actions.updates?.length > 0) {
      const invalidPrices = actions.updates.filter(u => u.newPriceAda < this.MIN_PRICE_ADA);
      if (invalidPrices.length > 0) {
        throw new Error(`All updated listings must have a minimum price of ${this.MIN_PRICE_ADA} ADA`);
      }
    }

    // Validate minimum prices for offers
    if (actions.offers?.length > 0) {
      const invalidOffers = actions.offers.filter(o => o.priceAda < this.MIN_PRICE_ADA);
      if (invalidOffers.length > 0) {
        throw new Error(`All offers must be at least ${this.MIN_PRICE_ADA} ADA`);
      }
    }

    // Validate minimum prices for purchases
    if (actions.purchases?.length > 0) {
      const invalidPrices = actions.purchases.filter(p => p.priceAda < this.MIN_PRICE_ADA);
      if (invalidPrices.length > 0) {
        throw new Error(`All NFT purchases must be at least ${this.MIN_PRICE_ADA} ADA`);
      }
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

    // Collect target NFTs for listings if any
    const targetAssets =
      actions.listings?.map(listing => ({
        token: listing.policyId + listing.assetName,
        amount: 1,
      })) ?? [];

    let serializedUtxos: string[];

    // Case 1: If we have listings, use getUtxosExtract to get NFT UTXOs
    if (targetAssets.length > 0) {
      const result = await getUtxosExtract(Address.from_bech32(address), this.blockfrost, {
        targetAssets,
        maxUtxos: 25,
      });
      serializedUtxos = result.utxos;
    }
    // Case 2: Only unlistings/updates - need pure ADA
    else if ((actions.unlistings?.length ?? 0) > 0 || (actions.updates?.length ?? 0) > 0) {
      const allUtxos = await this.blockfrost.addressesUtxosAll(address);
      const pureAdaUtxos = allUtxos.filter(u => u.amount.length === 1 && u.amount[0].unit === 'lovelace');

      if (pureAdaUtxos.length === 0) {
        throw new Error('No pure ADA UTXOs available in treasury wallet to fund transaction');
      }

      serializedUtxos = pureAdaUtxos.slice(0, 10).map(u => {
        const value = Value.new(BigNum.from_str(u.amount[0].quantity));
        const txOut = TransactionOutput.new(Address.from_bech32(u.address), value);
        const txUtxo = TransactionUnspentOutput.new(
          TransactionInput.new(TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex')), u.output_index),
          txOut
        );
        return Buffer.from(txUtxo.to_bytes()).toString('hex');
      });
    }
    // Case 3: Offers/purchases - can use either approach
    else {
      const result = await getUtxosExtract(Address.from_bech32(address), this.blockfrost, {
        minAda: 1000000,
        maxUtxos: 25,
      });
      serializedUtxos = result.utxos;
    }

    if (serializedUtxos.length === 0) {
      throw new Error('No UTXOs available in treasury wallet to fund transaction');
    }

    // Build combined payload
    const combinedPayload: WayUpTransactionInput = {
      changeAddress: address,
      utxos: serializedUtxos,
    };

    // Add listings if provided
    if (actions.listings?.length > 0) {
      combinedPayload.create = actions.listings.map(listing => ({
        assets: {
          policyId: listing.policyId,
          assetName: listing.assetName,
        },
        priceAda: listing.priceAda,
      }));
    }

    // Add unlistings if provided (need to find output indices)
    if (actions.unlistings?.length > 0) {
      const unlistsWithIndices: { policyId: string; txHashIndex: string }[] = [];

      for (const unlist of actions.unlistings) {
        try {
          const outputIndex = await this.findListingOutputIndex(unlist.txHashIndex, unlist.policyId, unlist.assetName);
          unlistsWithIndices.push({
            policyId: unlist.policyId,
            txHashIndex: `${unlist.txHashIndex}#${outputIndex}`,
          });
        } catch (error) {
          this.logger.error(`Failed to find output index for unlist ${unlist.policyId}: ${error.message}`);
          throw new Error(`Cannot unlist ${unlist.policyId}: ${error.message}`);
        }
      }

      combinedPayload.unlist = unlistsWithIndices;
    }

    // Add updates if provided (need to find output indices)
    if (actions.updates?.length > 0) {
      const updatesWithIndices: { policyId: string; txHashIndex: string; newPriceAda: number }[] = [];

      for (const update of actions.updates) {
        try {
          const outputIndex = await this.findListingOutputIndex(update.txHashIndex, update.policyId, update.assetName);
          updatesWithIndices.push({
            policyId: update.policyId,
            txHashIndex: `${update.txHashIndex}#${outputIndex}`,
            newPriceAda: update.newPriceAda,
          });
        } catch (error) {
          this.logger.error(`Failed to find output index for update ${update.policyId}: ${error.message}`);
          throw new Error(`Cannot update listing for ${update.policyId}: ${error.message}`);
        }
      }

      combinedPayload.update = updatesWithIndices;
    }

    // Add offers if provided
    if (actions.offers?.length > 0) {
      combinedPayload.createOffer = actions.offers;
    }

    // Add purchases if provided
    if (actions.purchases?.length > 0) {
      combinedPayload.buy = actions.purchases;
    }

    this.logger.log(
      `Building combined transaction: ` +
        `${actions.listings?.length ?? 0} listings, ` +
        `${actions.unlistings?.length ?? 0} unlistings, ` +
        `${actions.updates?.length ?? 0} updates, ` +
        `${actions.offers?.length ?? 0} offers, ` +
        `${actions.purchases?.length ?? 0} purchases`
    );

    // Build the transaction
    const buildResponse = await this.blockchainService.buildWayUpTransaction(combinedPayload);

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing combined marketplace transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.transactions[0]);

    // Submit the transaction
    this.logger.log('Submitting combined marketplace transaction to blockchain');
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: signedTx,
    });

    const summary = {
      listedCount: actions.listings?.length ?? 0,
      unlistedCount: actions.unlistings?.length ?? 0,
      updatedCount: actions.updates?.length ?? 0,
      offersCount: actions.offers?.length ?? 0,
      purchasedCount: actions.purchases?.length ?? 0,
    };

    this.logger.log(`Combined marketplace transaction completed successfully. TxHash: ${submitResponse.txHash}`);
    this.logger.log(`Summary: ${JSON.stringify(summary)}`);

    return {
      txHash: submitResponse.txHash,
      summary,
    };
  }

  /**
   * Find the output index of an NFT in a listing transaction
   * The NFT will be in an output that has a data_hash (marketplace script)
   *
   * @param listingTxHash - The transaction hash where the NFT was listed
   * @param policyId - The policy ID of the NFT
   * @param assetName - The hex-encoded asset name of the NFT
   * @returns The output index, or throws if not found
   */
  private async findListingOutputIndex(listingTxHash: string, policyId: string, assetName: string): Promise<number> {
    try {
      this.logger.log(`Finding output index for NFT ${policyId}${assetName} in tx ${listingTxHash}`);

      const txUtxos = await this.blockfrost.txsUtxos(listingTxHash);
      const fullAssetId = policyId + assetName;

      // Find the output that contains the NFT and has a data_hash (marketplace script)
      for (let i = 0; i < txUtxos.outputs.length; i++) {
        const output = txUtxos.outputs[i];

        // Check if this output has the NFT
        const hasNFT = output.amount.some(amt => amt.unit === fullAssetId);

        // Check if this output has a data_hash (indicating it's sent to a script)
        if (hasNFT && output.data_hash) {
          this.logger.log(`Found NFT at output index ${i} in tx ${listingTxHash}`);
          return i;
        }
      }

      throw new Error(`Could not find NFT ${policyId}${assetName} in marketplace script output of tx ${listingTxHash}`);
    } catch (error) {
      this.logger.error(`Error finding output index for tx ${listingTxHash}: ${error.message}`, error.stack);
      throw error;
    }
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
      const { privateKey } = await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);

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
}
