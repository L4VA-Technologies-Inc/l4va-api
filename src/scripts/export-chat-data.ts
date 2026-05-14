/**
 * Script to export all Stream Chat data for migration
 *
 * Usage:
 *   npx ts-node src/scripts/export-chat-data.ts
 *
 * This will:
 * 1. Export all channels and users from your current Stream account
 * 2. Poll for completion
 * 3. Download the export files
 * 4. Provide CLI commands to import into production
 */

/* eslint-disable no-console */

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

import * as dotenv from 'dotenv';
import { StreamChat } from 'stream-chat';

// Load environment variables
dotenv.config();

const POLL_INTERVAL = 5000; // 5 seconds
const MAX_POLLS = 120; // 10 minutes max wait time

class ChatMigrationExporter {
  private serverClient: StreamChat;

  constructor() {
    const apiKey = process.env.STREAM_API_KEY;
    const apiSecret = process.env.STREAM_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error('STREAM_API_KEY and STREAM_API_SECRET must be set');
    }

    this.serverClient = StreamChat.getInstance(apiKey, apiSecret);
    console.log('✓ Connected to Stream Chat');
  }

  async exportAllChannels(): Promise<string> {
    console.log('\n📤 Exporting all channels...');

    // Query all messaging channels
    const filter = { type: 'messaging' };
    const sort = [{ last_message_at: -1 }] as const;
    const channelsResponse = await this.serverClient.queryChannels(filter, sort, { limit: 100 });

    // Filter for vault channels only
    const channels = channelsResponse
      .filter(channel => channel.id?.startsWith('vault-'))
      .map(channel => ({
        type: 'messaging' as const,
        id: channel.id as string,
      }));

    console.log(`Found ${channels.length} channels to export`);

    if (channels.length === 0) {
      throw new Error('No channels found to export');
    }

    // Export in batches of 25
    const taskIds: string[] = [];
    for (let i = 0; i < channels.length; i += 25) {
      const batch = channels.slice(i, i + 25);
      const response = await this.serverClient.exportChannels(batch, {
        version: 'v2',
        include_truncated_messages: true,
        include_soft_deleted_channels: false,
      });
      taskIds.push(response.task_id);
      console.log(`  Batch ${Math.floor(i / 25) + 1}: ${response.task_id}`);
    }

    return taskIds[0]; // Return first task ID for simplicity
  }

  async exportAllUsers(): Promise<string[]> {
    console.log('\n👥 Exporting all users...');

    const users = await this.serverClient.queryUsers({}, { id: 1 }, { limit: 100 });
    const userIds = users.users.map(user => user.id);

    console.log(`Found ${userIds.length} users to export`);

    if (userIds.length === 0) {
      throw new Error('No users found to export');
    }

    // Export in batches of 25
    const taskIds: string[] = [];
    for (let i = 0; i < userIds.length; i += 25) {
      const batch = userIds.slice(i, i + 25);
      const response = await this.serverClient.exportUsers({ user_ids: batch });
      taskIds.push(response.task_id);
      console.log(`  Batch ${Math.floor(i / 25) + 1}: ${response.task_id}`);
    }

    return taskIds;
  }

  async waitForCompletion(taskId: string, isChannel: boolean = true): Promise<string> {
    for (let i = 0; i < MAX_POLLS; i++) {
      const response: any = isChannel
        ? await this.serverClient.getExportChannelStatus(taskId)
        : await this.serverClient.getTask(taskId);

      if (response.status === 'completed' && response.result?.url) {
        return response.result.url;
      }

      if (response.status === 'failed') {
        throw new Error(`Export failed: ${JSON.stringify(response.error)}`);
      }

      process.stdout.write(`  Status: ${response.status}... \r`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }

    throw new Error('Export timed out');
  }

  async downloadFile(url: string, filename: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const exportsDir = path.join(process.cwd(), 'exports');

      if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
      }

      const filePath = path.join(exportsDir, filename);
      const fileStream = fs.createWriteStream(filePath);

      https
        .get(url, response => {
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download: ${response.statusCode}`));
            return;
          }

          response.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close();
            resolve(filePath);
          });
        })
        .on('error', error => {
          fs.unlink(filePath, () => {});
          reject(error);
        });
    });
  }

  async run(): Promise<void> {
    try {
      console.log('🚀 Starting Stream Chat export for migration\n');

      // Export channels
      const channelTaskId = await this.exportAllChannels();
      console.log('\n⏳ Waiting for channel export to complete...');
      const channelUrl = await this.waitForCompletion(channelTaskId, true);
      console.log('\n✓ Channel export completed');

      // Export users
      const userTaskIds = await this.exportAllUsers();
      console.log('\n⏳ Waiting for user exports to complete...');
      const userUrls: string[] = [];
      for (const taskId of userTaskIds) {
        const url = await this.waitForCompletion(taskId, false);
        userUrls.push(url);
      }
      console.log('\n✓ User exports completed');

      // Download files
      console.log('\n📥 Downloading export files...');
      const channelFile = await this.downloadFile(channelUrl, `channels-${Date.now()}.jsonl`);
      console.log(`  ✓ Channels: ${channelFile}`);

      const userFiles: string[] = [];
      for (let i = 0; i < userUrls.length; i++) {
        const userFile = await this.downloadFile(userUrls[i], `users-${i + 1}-${Date.now()}.jsonl`);
        userFiles.push(userFile);
        console.log(`  ✓ Users batch ${i + 1}: ${userFile}`);
      }

      // Print instructions
      this.printImportInstructions(channelFile, userFiles);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('\n❌ Export failed:', errorMessage);
      process.exit(1);
    }
  }

  printImportInstructions(channelFile: string, userFiles: string[]): void {
    const prodKey = process.env.STREAM_API_KEY_PROD || 'YOUR_PROD_API_KEY';
    const prodSecret = process.env.STREAM_API_SECRET_PROD || 'YOUR_PROD_API_SECRET';

    console.log('\n' + '='.repeat(80));
    console.log('✅ EXPORT COMPLETED SUCCESSFULLY');
    console.log('='.repeat(80));
    console.log('\n📋 NEXT STEPS - Import to Production:\n');
    console.log('1. Install Stream CLI (if not already installed):');
    console.log('   brew tap GetStream/stream-cli https://github.com/GetStream/stream-cli');
    console.log('   brew install stream-cli\n');
    console.log('2. Configure CLI with PRODUCTION credentials:');
    console.log('   stream-cli config new\n');
    console.log(`   API Key: ${prodKey}`);
    console.log(`   API Secret: ${prodSecret}\n`);
    console.log('3. Import files (IMPORTANT: Users first, then channels):\n');
    console.log('   # Import users:');
    userFiles.forEach(file => {
      console.log(`   stream-cli chat upload-import ${file}`);
    });
    console.log('\n   # Then import channels:');
    console.log(`   stream-cli chat upload-import ${channelFile}\n`);
    console.log('4. Monitor import status:');
    console.log('   stream-cli chat get-import <IMPORT_ID> --watch\n');
    console.log('5. List all imports:');
    console.log('   stream-cli chat list-imports\n');
    console.log('📁 Files location: ' + path.join(process.cwd(), 'exports'));
    console.log('\n💡 Tips:');
    console.log('   - Use --mode insert to skip existing items');
    console.log('   - Default mode is upsert (overwrites existing)');
    console.log('   - Maximum file size: 300 MB per upload');
    console.log('   - Import users BEFORE channels to avoid validation errors');
    console.log('='.repeat(80) + '\n');
  }
}

// Run the exporter
const exporter = new ChatMigrationExporter();
exporter.run();
