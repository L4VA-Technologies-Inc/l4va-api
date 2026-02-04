import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
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
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class WayUpService {
  private readonly logger = new Logger(WayUpService.name);
  private readonly blockfrost: BlockFrostAPI;
  private readonly adminAddress: string;
  private readonly adminSKey: string;

  private readonly MIN_PRICE_ADA = 5; // Validate minimum price (5 ADA minimum per WayUp requirements)

  constructor(
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly treasuryWalletService: TreasuryWalletService,
    private readonly transactionsService: TransactionsService,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
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

    const treasuryAddress = vault.treasury_wallet.treasury_address;
    this.logger.log(`Using treasury wallet address: ${treasuryAddress}`);
    this.logger.log(`Using admin wallet for fees: ${this.adminAddress}`);

    // Collect target NFTs to list
    const targetAssets = listings.map(listing => ({
      token: listing.policyId + listing.assetName,
      amount: 1,
    }));

    // Get UTXOs containing the NFTs from treasury wallet
    const { utxos: treasuryUtxos, requiredInputs } = await getUtxosExtract(
      Address.from_bech32(treasuryAddress),
      this.blockfrost,
      {
        targetAssets,
        minAda: 0, // No ADA needed from treasury, just the NFTs
        maxUtxos: 20,
      }
    );

    if (!requiredInputs || requiredInputs.length === 0) {
      throw new Error('No UTXOs found containing the NFTs to list');
    }

    // Get admin UTXOs for transaction fees
    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
      minAda: 5_000_000, // 5 ADA for fees and minimum outputs
      maxUtxos: 5,
    });

    if (adminUtxos.length === 0) {
      throw new Error('Insufficient funds in admin wallet for transaction fees');
    }

    // Combine UTXOs from both wallets
    const combinedUtxos = [...treasuryUtxos, ...adminUtxos];

    // Create listing payload with admin as change address
    const listingPayload: ListingPayload = {
      changeAddress: this.adminAddress,
      utxos: combinedUtxos,
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

    // Create transaction record
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.wayup,
      assets: [],
      metadata: {
        operation: 'listing',
        listings,
        listingCount: listings.length,
      },
    });

    try {
      // Build the transaction
      const buildResponse = await this.blockchainService.buildWayUpTransaction(listingPayload);

      // Sign the transaction with both treasury and admin wallet keys
      const signedTx = await this.signTransactionWithBothWallets(vaultId, buildResponse.transactions[0]);

      // Submit the transaction
      this.logger.log('Submitting listing transaction to blockchain');
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: signedTx,
      });

      // Update transaction with hash and status
      await this.transactionsService.updateTransactionHash(transaction.id, submitResponse.txHash, {
        listedAssets: listings,
      });

      this.logger.log(`NFT listing created successfully. TxHash: ${submitResponse.txHash}`);

      return {
        txHash: submitResponse.txHash,
        listedAssets: listings,
      };
    } catch (error) {
      this.logger.error('Failed to create listing', error);
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      throw error;
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

    // Create transaction record
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.wayup,
      assets: [],
      metadata: {
        operation: 'unlisting',
        unlistings,
        unlistingCount: unlistings.length,
      },
    });

    try {
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

      const treasuryAddress = vault.treasury_wallet.treasury_address;
      this.logger.log(`Treasury wallet address (NFTs will return here): ${treasuryAddress}`);
      this.logger.log(`Using admin wallet for fees: ${this.adminAddress}`);

      // Get admin UTXOs for transaction fees
      const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
        minAda: 2_000_000, // 2 ADA for fees
        maxUtxos: 5,
      });

      if (adminUtxos.length === 0) {
        throw new Error('Insufficient funds in admin wallet for unlist transaction fees');
      }

      // Create unlist payload with admin as change address
      const unlistPayload: UnlistPayload = {
        changeAddress: this.adminAddress,
        utxos: adminUtxos,
        unlist: unlistings,
      };

      this.logger.log(`Building unlist transaction for ${unlistings.length} listing(s)`);
      this.logger.log(`Unlistings: ${JSON.stringify(unlistings)}`);

      // Build the transaction
      const buildResponse = await this.blockchainService.buildWayUpTransaction(unlistPayload);

      // Sign the transaction with both treasury and admin wallet
      // Treasury signature needed because the listing was created by treasury wallet
      const signedTx = await this.signTransactionWithBothWallets(vaultId, buildResponse.transactions[0]);

      // Submit the transaction
      this.logger.log('Submitting unlist transaction to blockchain');
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: signedTx,
      });

      // Update transaction with hash and status
      await this.transactionsService.updateTransactionHash(transaction.id, submitResponse.txHash);

      this.logger.log(`NFT unlisting completed successfully. TxHash: ${submitResponse.txHash}`);
      this.logger.log(`${unlistings.length} NFT(s) returned to treasury wallet: ${treasuryAddress}`);

      return {
        txHash: submitResponse.txHash,
        unlistedAssets: unlistings,
      };
    } catch (error) {
      this.logger.error('Failed to unlist NFTs', error);
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      throw error;
    }
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

    // Create transaction record
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.wayup,
      assets: [],
      metadata: {
        operation: 'updateListing',
        updates,
        updateCount: updates.length,
      },
    });

    try {
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

      const treasuryAddress = vault.treasury_wallet.treasury_address;
      this.logger.log(`Treasury wallet address: ${treasuryAddress}`);
      this.logger.log(`Using admin wallet for fees: ${this.adminAddress}`);

      // Get admin UTXOs for transaction fees
      const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
        minAda: 2_000_000, // 2 ADA for fees
        maxUtxos: 5,
      });

      if (adminUtxos.length === 0) {
        throw new Error('Insufficient funds in admin wallet for update transaction fees');
      }

      // Create update payload with admin as change address
      const updatePayload: UpdateListingPayload = {
        changeAddress: this.adminAddress,
        utxos: adminUtxos,
        update: updates,
      };

      this.logger.log(`Building update transaction for ${updates.length} listing(s)`);
      this.logger.log(`Updates: ${JSON.stringify(updates)}`);

      // Build the transaction
      const buildResponse = await this.blockchainService.buildWayUpTransaction(updatePayload);

      // Sign the transaction with both treasury and admin wallet
      // Treasury signature needed because the listing was created by treasury wallet
      const signedTx = await this.signTransactionWithBothWallets(vaultId, buildResponse.transactions[0]);

      // Submit the transaction
      this.logger.log('Submitting update listing transaction to blockchain');
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: signedTx,
      });

      // Update transaction with hash and status
      await this.transactionsService.updateTransactionHash(transaction.id, submitResponse.txHash, {
        updatedAssets: updates,
      });

      this.logger.log(`NFT listing update completed successfully. TxHash: ${submitResponse.txHash}`);
      this.logger.log(`${updates.length} listing(s) updated with new prices`);

      return {
        txHash: submitResponse.txHash,
        updatedAssets: updates,
      };
    } catch (error) {
      this.logger.error('Failed to update listing', error);
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      throw error;
    }
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

    // Create transaction record
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.wayup,
      assets: [],
      metadata: {
        operation: 'offer',
        offers,
        offerCount: offers.length,
      },
    });

    try {
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

      const treasuryAddress = vault.treasury_wallet.treasury_address;
      this.logger.log(`Using treasury wallet for offer funds: ${treasuryAddress}`);
      this.logger.log(`Using admin wallet for fees: ${this.adminAddress}`);

      // Calculate total ADA needed for all offers (in lovelace)
      const totalOfferAda = offers.reduce((sum, offer) => sum + offer.priceAda, 0);
      const totalOfferLovelace = totalOfferAda * 1_000_000;
      this.logger.log(`Total ADA needed for offers: ${totalOfferAda} ADA (${totalOfferLovelace} lovelace)`);

      // Get treasury UTXOs for offer amount
      const { utxos: treasuryUtxos, totalAdaCollected } = await getUtxosExtract(
        Address.from_bech32(treasuryAddress),
        this.blockfrost,
        {
          targetAdaAmount: totalOfferLovelace, // Just the offer amount, no fees
          maxUtxos: 10,
        }
      );

      if (treasuryUtxos.length === 0) {
        throw new Error('Insufficient funds in treasury wallet for offer amount');
      }

      this.logger.log(`Collected ${totalAdaCollected} lovelace from treasury for offers`);

      // Get admin UTXOs for transaction fees
      const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
        minAda: 2_000_000, // 2 ADA for fees
        maxUtxos: 5,
      });

      if (adminUtxos.length === 0) {
        throw new Error('Insufficient funds in admin wallet for transaction fees');
      }

      // Combine UTXOs from both wallets
      const combinedUtxos = [...treasuryUtxos, ...adminUtxos];

      // Create offer payload with admin as change address
      const offerPayload: MakeOfferPayload = {
        changeAddress: this.adminAddress,
        utxos: combinedUtxos,
        createOffer: offers,
      };

      this.logger.log(`Building offer transaction for ${offers.length} NFT(s)`);
      this.logger.log(`Offers: ${JSON.stringify(offers)}`);

      // Build the transaction
      const buildResponse = await this.blockchainService.buildWayUpTransaction(offerPayload);

      // Sign the transaction with both treasury and admin wallet keys
      const signedTx = await this.signTransactionWithBothWallets(vaultId, buildResponse.transactions[0]);

      // Submit the transaction
      this.logger.log('Submitting offer transaction to blockchain');
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: signedTx,
      });

      // Update transaction with hash and status
      await this.transactionsService.updateTransactionHash(transaction.id, submitResponse.txHash, {
        submittedOffers: offers,
      });

      this.logger.log(`NFT offer(s) submitted successfully. TxHash: ${submitResponse.txHash}`);
      this.logger.log(`${offers.length} offer(s) submitted for NFTs`);

      return {
        txHash: submitResponse.txHash,
        offers: offers,
      };
    } catch (error) {
      this.logger.error('Failed to make offer', error);
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      throw error;
    }
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

    // Create transaction record
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.wayup,
      assets: [],
      metadata: {
        operation: 'purchase',
        purchases,
        purchaseCount: purchases.length,
      },
    });

    try {
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

      const treasuryAddress = vault.treasury_wallet.treasury_address;
      this.logger.log(`Using treasury wallet for purchase funds: ${treasuryAddress}`);
      this.logger.log(`Using admin wallet for fees: ${this.adminAddress}`);

      // Calculate total ADA needed for all purchases (in lovelace)
      const totalPurchaseAda = purchases.reduce((sum, purchase) => sum + purchase.priceAda, 0);
      const totalPurchaseLovelace = totalPurchaseAda * 1_000_000;
      this.logger.log(`Total ADA needed for purchases: ${totalPurchaseAda} ADA (${totalPurchaseLovelace} lovelace)`);

      // Get treasury UTXOs for purchase amount
      const { utxos: treasuryUtxos, totalAdaCollected } = await getUtxosExtract(
        Address.from_bech32(treasuryAddress),
        this.blockfrost,
        {
          targetAdaAmount: totalPurchaseLovelace, // Just the purchase amount, no fees
          maxUtxos: 15,
        }
      );

      if (treasuryUtxos.length === 0) {
        throw new Error('Insufficient funds in treasury wallet for purchase amount');
      }

      this.logger.log(`Collected ${totalAdaCollected} lovelace from treasury for purchases`);

      // Get admin UTXOs for transaction fees
      const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
        minAda: 2_000_000, // 2 ADA for fees
        maxUtxos: 5,
      });

      if (adminUtxos.length === 0) {
        throw new Error('Insufficient funds in admin wallet for transaction fees');
      }

      // Combine UTXOs from both wallets
      const combinedUtxos = [...treasuryUtxos, ...adminUtxos];

      // Create buy payload with admin as change address
      const buyPayload: BuyNFTPayload = {
        changeAddress: this.adminAddress,
        utxos: combinedUtxos,
        buy: purchases,
      };

      this.logger.log(`Building purchase transaction for ${purchases.length} NFT(s)`);
      this.logger.log(`Purchases: ${JSON.stringify(purchases)}`);

      // Build the transaction
      const buildResponse = await this.blockchainService.buildWayUpTransaction(buyPayload);

      // Sign the transaction with both treasury and admin wallet keys
      const signedTx = await this.signTransactionWithBothWallets(vaultId, buildResponse.transactions[0]);

      // Submit the transaction
      this.logger.log('Submitting purchase transaction to blockchain');
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: signedTx,
      });

      // Update transaction with hash and status
      await this.transactionsService.updateTransactionHash(transaction.id, submitResponse.txHash, {
        purchasedAssets: purchases,
      });

      this.logger.log(`NFT purchase completed successfully. TxHash: ${submitResponse.txHash}`);
      this.logger.log(`${purchases.length} NFT(s) purchased and delivered to treasury wallet: ${treasuryAddress}`);

      return {
        txHash: submitResponse.txHash,
        purchases: purchases,
      };
    } catch (error) {
      this.logger.error('Failed to buy NFT', error);
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      throw error;
    }
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

    // Create transaction record
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.wayup,
      assets: [],
      metadata: {
        operation: 'combined',
        summary: {
          listedCount: actions.listings?.length ?? 0,
          unlistedCount: actions.unlistings?.length ?? 0,
          updatedCount: actions.updates?.length ?? 0,
          offersCount: actions.offers?.length ?? 0,
          purchasedCount: actions.purchases?.length ?? 0,
        },
      },
    });

    try {
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

      const treasuryAddress = vault.treasury_wallet.treasury_address;
      this.logger.log(`Using treasury wallet address: ${treasuryAddress}`);
      this.logger.log(`Using admin wallet for fees: ${this.adminAddress}`);

      // Collect target NFTs for listings if any
      const targetAssets =
        actions.listings?.map(listing => ({
          token: listing.policyId + listing.assetName,
          amount: 1,
        })) ?? [];

      // Calculate total ADA needed from treasury for offers and purchases
      const offerAmount = (actions.offers?.reduce((sum, o) => sum + o.priceAda, 0) ?? 0) * 1_000_000;
      const purchaseAmount = (actions.purchases?.reduce((sum, p) => sum + p.priceAda, 0) ?? 0) * 1_000_000;
      const totalTreasuryAda = offerAmount + purchaseAmount;

      let treasuryUtxos: string[] = [];
      let needsTreasuryUtxos = false;

      // Get treasury UTXOs if we need NFTs or ADA for offers/purchases
      if (targetAssets.length > 0 || totalTreasuryAda > 0) {
        needsTreasuryUtxos = true;
        const result = await getUtxosExtract(Address.from_bech32(treasuryAddress), this.blockfrost, {
          targetAssets: targetAssets.length > 0 ? targetAssets : undefined,
          targetAdaAmount: totalTreasuryAda > 0 ? totalTreasuryAda : undefined,
          minAda: 0,
          maxUtxos: 20,
        });
        treasuryUtxos = result.utxos;

        if (treasuryUtxos.length === 0) {
          throw new Error('Required assets not found in treasury wallet');
        }
      }

      // Get admin UTXOs for transaction fees
      const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
        minAda: 2_000_000,
        maxUtxos: 5,
      });

      if (adminUtxos.length === 0) {
        throw new Error('Insufficient funds in admin wallet for transaction fees');
      }

      // Combine UTXOs from both wallets
      const combinedUtxos = needsTreasuryUtxos ? [...treasuryUtxos, ...adminUtxos] : adminUtxos;

      // Build action summary for message
      const actionParts: string[] = [];
      if (actions.listings?.length) actionParts.push(`listing ${actions.listings.length} NFT(s)`);
      if (actions.unlistings?.length) actionParts.push(`unlisting ${actions.unlistings.length}`);
      if (actions.updates?.length) actionParts.push(`updating ${actions.updates.length}`);
      if (actions.offers?.length) actionParts.push(`offering on ${actions.offers.length}`);
      if (actions.purchases?.length) actionParts.push(`buying ${actions.purchases.length}`);

      // Build combined payload
      const combinedPayload: WayUpTransactionInput = {
        changeAddress: this.adminAddress,
        utxos: combinedUtxos,
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
            const outputIndex = await this.findListingOutputIndex(
              unlist.txHashIndex,
              unlist.policyId,
              unlist.assetName
            );
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
            const outputIndex = await this.findListingOutputIndex(
              update.txHashIndex,
              update.policyId,
              update.assetName
            );
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

      // Sign the transaction with appropriate keys
      // Always sign with both wallets for any marketplace operation involving vault listings
      const signedTx = await this.signTransactionWithBothWallets(vaultId, buildResponse.transactions[0]);

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

      // Update transaction with hash and status
      await this.transactionsService.updateTransactionHash(transaction.id, submitResponse.txHash, {
        executedActions: summary,
      });
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.submitted);

      this.logger.log(`Combined marketplace transaction completed successfully. TxHash: ${submitResponse.txHash}`);
      this.logger.log(`Summary: ${JSON.stringify(summary)}`);

      return {
        txHash: submitResponse.txHash,
        summary,
      };
    } catch (error) {
      this.logger.error('Failed to execute combined marketplace actions', error);
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      throw error;
    }
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
   * Sign a transaction using only the admin wallet private key
   *
   * @param txHex - Transaction hex to sign
   * @returns Signed transaction hex
   */
  private async signTransactionWithAdmin(txHex: string): Promise<string> {
    try {
      const txToSign = FixedTransaction.from_bytes(Buffer.from(txHex, 'hex'));
      const adminPrivateKey = PrivateKey.from_bech32(this.adminSKey);
      txToSign.sign_and_add_vkey_signature(adminPrivateKey);

      return Buffer.from(txToSign.to_bytes()).toString('hex');
    } catch (error) {
      this.logger.error('Failed to sign transaction with admin wallet', error);
      throw new Error(`Failed to sign transaction: ${error.message}`);
    }
  }

  /**
   * Sign a transaction using both the vault's treasury wallet and admin wallet private keys
   *
   * @param vaultId - The vault ID
   * @param txHex - Transaction hex to sign
   * @returns Signed transaction hex
   */
  private async signTransactionWithBothWallets(vaultId: string, txHex: string): Promise<string> {
    try {
      // Get the decrypted private key from treasury wallet
      const { privateKey, stakePrivateKey } = await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);

      // Deserialize and sign the transaction using FixedTransaction
      const txToSign = FixedTransaction.from_bytes(Buffer.from(txHex, 'hex'));

      // Sign with treasury keys
      txToSign.sign_and_add_vkey_signature(privateKey);
      txToSign.sign_and_add_vkey_signature(stakePrivateKey);

      // Sign with admin key
      const adminPrivateKey = PrivateKey.from_bech32(this.adminSKey);
      txToSign.sign_and_add_vkey_signature(adminPrivateKey);

      // Return the signed transaction as hex
      return Buffer.from(txToSign.to_bytes()).toString('hex');
    } catch (error) {
      this.logger.error(`Failed to sign transaction for vault ${vaultId}`, error);
      throw new Error(`Failed to sign transaction: ${error.message}`);
    }
  }

  /**
   * Sign a transaction using the vault's treasury wallet private key (legacy method)
   *
   * @param vaultId - The vault ID
   * @param txHex - Transaction hex to sign
   * @returns Signed transaction hex
   */
  private async signTransaction(vaultId: string, txHex: string): Promise<string> {
    try {
      // Get the decrypted private key from treasury wallet
      const { privateKey, stakePrivateKey } = await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);

      // Deserialize and sign the transaction using FixedTransaction
      const txToSign = FixedTransaction.from_bytes(Buffer.from(txHex, 'hex'));
      txToSign.sign_and_add_vkey_signature(privateKey);
      txToSign.sign_and_add_vkey_signature(stakePrivateKey);

      // Return the signed transaction as hex
      return Buffer.from(txToSign.to_bytes()).toString('hex');
    } catch (error) {
      this.logger.error(`Failed to sign transaction for vault ${vaultId}`, error);
      throw new Error(`Failed to sign transaction: ${error.message}`);
    }
  }
}
