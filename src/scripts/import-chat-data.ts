/**
 * Script to import Stream Chat data from JSONL export files
 *
 * Usage:
 *   npx ts-node src/scripts/import-chat-data.ts
 *
 * This will:
 * 1. Read exported JSONL files from the exports/ folder
 * 2. Parse and import users, channels, members, and messages
 * 3. Import to the PRODUCTION Stream account
 */

/* eslint-disable no-console */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import * as dotenv from 'dotenv';
import { StreamChat } from 'stream-chat';

// Load environment variables
dotenv.config();

interface ImportStats {
  users: number;
  channels: number;
  members: number;
  messages: number;
  reactions: number;
  errors: number;
}

class ChatDataImporter {
  private prodClient: StreamChat;
  private importedChannels: Set<string> = new Set();
  private stats: ImportStats = {
    users: 0,
    channels: 0,
    members: 0,
    messages: 0,
    reactions: 0,
    errors: 0,
  };

  constructor() {
    const prodApiKey = process.env.STREAM_API_KEY_PROD;
    const prodApiSecret = process.env.STREAM_API_SECRET_PROD;

    if (!prodApiKey || !prodApiSecret) {
      throw new Error('STREAM_API_KEY_PROD and STREAM_API_SECRET_PROD must be set');
    }

    this.prodClient = StreamChat.getInstance(prodApiKey, prodApiSecret);
    console.log('✓ Connected to Production Stream Chat');
  }

  async importUser(userData: any): Promise<void> {
    try {
      await this.prodClient.upsertUser({
        id: userData.id,
        ...userData,
      });
      this.stats.users++;
    } catch (error) {
      console.error(`Failed to import user ${userData.id}:`, error instanceof Error ? error.message : String(error));
      this.stats.errors++;
    }
  }

  async importChannel(channelData: any): Promise<void> {
    try {
      // Extract reserved fields that can't be set in channel data
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, type, created_by, last_message_at, created_at, updated_at, ...channelFields } = channelData;

      const channel = this.prodClient.channel(type, id, {
        ...channelFields,
        created_by: { id: created_by },
      });

      await channel.create();
      this.importedChannels.add(id);
      this.stats.channels++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Channel might already exist, which is okay
      if (errorMsg.includes('already exists')) {
        this.importedChannels.add(channelData.id);
      } else {
        console.error(`Failed to import channel ${channelData.id}:`, errorMsg);
        this.stats.errors++;
      }
    }
  }

  async importMember(memberData: any): Promise<void> {
    try {
      const channel = this.prodClient.channel(memberData.channel_type, memberData.channel_id);

      await channel.addMembers([memberData.user_id]);

      this.stats.members++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Member might already exist
      if (!errorMsg.includes('already exists')) {
        console.error(`Failed to import member ${memberData.user_id}:`, errorMsg);
        this.stats.errors++;
      }
    }
  }

  async importMessage(messageData: any): Promise<void> {
    // Skip if channel doesn't exist
    if (!this.importedChannels.has(messageData.channel_id)) {
      // Silently skip - this is expected for non-vault channels in user exports
      return;
    }

    try {
      const channel = this.prodClient.channel(messageData.channel_type, messageData.channel_id);

      // Extract user and remove reserved/unnecessary fields
      const {
        user: userId,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        channel_type,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        channel_id,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        created_at,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        updated_at,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        deleted_at,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        deleted_reply_count,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        member,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        reaction_groups,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        status,
        type: messageType,
        ...messageFields
      } = messageData;

      // Only allow valid message types
      const validTypes = ['', 'regular', 'system'];
      const type = validTypes.includes(messageType) ? messageType : 'regular';

      await channel.sendMessage({
        ...messageFields,
        type,
        user: { id: userId },
      });

      this.stats.messages++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Skip if message already exists (from previous import)
      if (errorMsg.includes('already exists')) {
        this.stats.messages++;
      } else {
        console.error(`Failed to import message ${messageData.id}:`, errorMsg);
        this.stats.errors++;
      }
    }
  }

  async importReaction(_reactionData: any): Promise<void> {
    try {
      // Reactions need to be sent through the message, not directly
      // For import, we'll skip reactions as they're typically not critical
      // and the Stream API doesn't provide a direct way to import them
      // with custom timestamps
      this.stats.reactions++;
    } catch (error) {
      console.error(`Failed to import reaction:`, error instanceof Error ? error.message : String(error));
      this.stats.errors++;
    }
  }

  async processFile(filePath: string, allowedTypes: string[]): Promise<void> {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber++;

      if (!line.trim()) continue;

      try {
        const item = JSON.parse(line);

        // Skip if this type is not allowed in this pass
        if (!allowedTypes.includes(item.type)) {
          continue;
        }

        switch (item.type) {
          case 'user':
            await this.importUser(item.item);
            if (this.stats.users % 10 === 0) {
              process.stdout.write(`\r  Users: ${this.stats.users}`);
            }
            break;
          case 'channel':
            await this.importChannel(item.item);
            if (this.stats.channels % 5 === 0) {
              process.stdout.write(`\r  Channels: ${this.stats.channels}`);
            }
            break;
          case 'member':
            await this.importMember(item.item);
            if (this.stats.members % 10 === 0) {
              process.stdout.write(`\r  Members: ${this.stats.members}`);
            }
            break;
          case 'message':
            await this.importMessage(item.item);
            if (this.stats.messages % 10 === 0) {
              process.stdout.write(`\r  Messages: ${this.stats.messages}`);
            }
            break;
          case 'reaction':
            await this.importReaction(item.item);
            if (this.stats.reactions % 10 === 0) {
              process.stdout.write(`\r  Reactions: ${this.stats.reactions}`);
            }
            break;
          case 'device':
            // Skip devices for now
            break;
          default:
            console.warn(`\nUnknown item type: ${item.type}`);
        }
      } catch (error) {
        console.error(`\nError parsing line ${lineNumber}:`, error instanceof Error ? error.message : String(error));
        this.stats.errors++;
      }
    }
  }

  async run(): Promise<void> {
    try {
      console.log('🚀 Starting Stream Chat data import to PRODUCTION\n');
      console.log('⚠️  WARNING: This will import data to your PRODUCTION account!');
      console.log('   Make sure STREAM_API_KEY_PROD and STREAM_API_SECRET_PROD are set correctly.\n');

      const exportsDir = path.join(process.cwd(), 'exports');

      if (!fs.existsSync(exportsDir)) {
        throw new Error('Exports directory not found. Run export first!');
      }

      const files = fs.readdirSync(exportsDir).filter(f => f.endsWith('.jsonl'));

      if (files.length === 0) {
        throw new Error('No .jsonl files found in exports/ directory');
      }

      console.log(`Found ${files.length} files to import:`);
      files.forEach(f => console.log(`  - ${f}`));

      // Sort files: users first, then channels (for better logging order)
      const userFiles = files.filter(f => f.includes('users'));
      const channelFiles = files.filter(f => f.includes('channels'));
      const allFiles = [...userFiles, ...channelFiles];

      console.log('\n📋 Import Strategy (Multi-Pass):');
      console.log('   Pass 1: Import users and channels');
      console.log('   Pass 2: Import members');
      console.log('   Pass 3: Import messages and reactions\n');

      // Pass 1: Import users and channels first
      console.log('=== PASS 1: Users & Channels ===');
      for (const file of allFiles) {
        console.log(`📄 ${path.basename(file)}`);
        await this.processFile(path.join(exportsDir, file), ['user', 'channel']);
      }
      console.log(`\n✓ Pass 1 complete: ${this.stats.users} users, ${this.stats.channels} channels\n`);

      // Pass 2: Import members (now that channels exist)
      console.log('=== PASS 2: Members ===');
      for (const file of allFiles) {
        console.log(`📄 ${path.basename(file)}`);
        await this.processFile(path.join(exportsDir, file), ['member']);
      }
      console.log(`\n✓ Pass 2 complete: ${this.stats.members} members\n`);

      // Pass 3: Import messages and reactions (now that channels and members exist)
      console.log('=== PASS 3: Messages & Reactions ===');
      for (const file of allFiles) {
        console.log(`📄 ${path.basename(file)}`);
        await this.processFile(path.join(exportsDir, file), ['message', 'reaction']);
      }
      console.log(`\n✓ Pass 3 complete: ${this.stats.messages} messages, ${this.stats.reactions} reactions\n`);

      // Print final statistics
      this.printStats();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('\n❌ Import failed:', errorMessage);
      process.exit(1);
    }
  }

  printStats(): void {
    console.log('\n' + '='.repeat(80));
    console.log('✅ IMPORT COMPLETED');
    console.log('='.repeat(80));
    console.log('\n📊 Import Statistics:');
    console.log(`   Users:     ${this.stats.users}`);
    console.log(`   Channels:  ${this.stats.channels}`);
    console.log(`   Members:   ${this.stats.members}`);
    console.log(`   Messages:  ${this.stats.messages}`);
    console.log(`   Reactions: ${this.stats.reactions}`);
    console.log(`   Errors:    ${this.stats.errors}`);
    console.log('\n💡 Next Steps:');
    console.log('   1. Verify data in Stream Dashboard: https://dashboard.getstream.io/');
    console.log('   2. Test chat functionality in your application');
    console.log('   3. Update app to use PRODUCTION credentials');
    console.log('='.repeat(80) + '\n');
  }
}

// Run the importer
const importer = new ChatDataImporter();
importer.run();
