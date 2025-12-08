import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import CardanoWasm, { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from '@/database/vault.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
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

interface BuyNFTInput {
  policyId: string;
  txHashIndex: string; // Format: txHash#outputIndex
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

interface BuyNFTPayload {
  changeAddress: string;
  utxos: string[];
  buy: BuyNFTInput[];
}

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
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
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
      CardanoWasm.Address.from_bech32(address),
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

    // Get UTXOs to fund the unlist transaction using getUtxosExtract
    const { utxos: serializedUtxos } = await getUtxosExtract(
      CardanoWasm.Address.from_bech32(address),
      this.blockfrost,
      {
        minAda: 1000000,
        maxUtxos: 10,
      }
    );

    if (serializedUtxos.length === 0) {
      throw new Error('No UTXOs available in treasury wallet to fund unlist transaction');
    }

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

    // Get UTXOs to fund the update transaction using getUtxosExtract
    const { utxos: serializedUtxos } = await getUtxosExtract(
      CardanoWasm.Address.from_bech32(address),
      this.blockfrost,
      {
        minAda: 1000000,
        maxUtxos: 10,
      }
    );

    if (serializedUtxos.length === 0) {
      throw new Error('No UTXOs available in treasury wallet to fund update transaction');
    }

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

    // Calculate total ADA needed for all offers (in lovelace)
    const totalOfferAda = offers.reduce((sum, offer) => sum + offer.priceAda, 0);
    const totalOfferLovelace = totalOfferAda * 1_000_000;
    this.logger.log(`Total ADA needed for offers: ${totalOfferAda} ADA (${totalOfferLovelace} lovelace)`);

    // Get UTXOs to fund the offer transaction using getUtxosExtract with targetAdaAmount
    const { utxos: serializedUtxos, totalAdaCollected } = await getUtxosExtract(
      CardanoWasm.Address.from_bech32(address),
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
      CardanoWasm.Address.from_bech32(address),
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

    if (!buildResponse.complete) {
      throw new Error('Failed to build purchase transaction');
    }

    // Sign the transaction with treasury wallet private key
    this.logger.log('Signing purchase transaction with treasury wallet');
    const signedTx = await this.signTransaction(vaultId, buildResponse.complete);

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
}
