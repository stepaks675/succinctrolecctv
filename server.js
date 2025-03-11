import express from 'express';
import cors from 'cors';
import { Client, GatewayIntentBits, Events } from "discord.js";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = "/app/data/role_monitoring.db";
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'default-api-key';

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Simple API key middleware for protection
const apiKeyAuth = (req, res, next) => {
  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
  }
  next();
};

// Import your existing bot code
import { 
  TARGET_ROLES, 
  initDatabase, 
  processMessage, 
  createSnapshot, 
  cleanupOldSnapshots, 
  printStats, 
  setupAutomaticSnapshots 
} from './rolecctv.js';

let db;

// API Routes
app.get('/', (req, res) => {
  res.json({ status: 'Discord Bot API is running' });
});

// Get all snapshots or a specific snapshot with detailed user data
app.get('/api/snapshots/:id?', apiKeyAuth, async (req, res) => {
  try {
    const snapshotId = req.params.id;
    
    // If no ID provided, return list of all snapshots
    if (!snapshotId) {
      const snapshots = await db.all(`
        SELECT id, name, created_at, 
        (SELECT COUNT(*) FROM snapshot_data WHERE snapshot_id = snapshots.id) as record_count
        FROM snapshots
        ORDER BY created_at DESC
      `);
      
      return res.json(snapshots);
    }
    
    // Get specific snapshot info
    const snapshot = await db.get(`
      SELECT id, name, created_at
      FROM snapshots
      WHERE id = ?
    `, [snapshotId]);
    
    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    
    // Get user summary data for this snapshot
    const users = await db.all(`
      SELECT 
        user_id, 
        username, 
        roles,
        SUM(message_count) as total_messages
      FROM snapshot_data
      WHERE snapshot_id = ?
      GROUP BY user_id
      ORDER BY total_messages DESC
    `, [snapshotId]);
    
    // Get channel activity for each user in a single query
    const channelActivity = await db.all(`
      SELECT 
        user_id,
        channel_id,
        channel_name,
        message_count
      FROM snapshot_data
      WHERE snapshot_id = ?
      ORDER BY user_id, message_count DESC
    `, [snapshotId]);
    
    // Organize channel data by user
    const userChannels = {};
    channelActivity.forEach(activity => {
      if (!userChannels[activity.user_id]) {
        userChannels[activity.user_id] = [];
      }
      userChannels[activity.user_id].push({
        channel_id: activity.channel_id,
        channel_name: activity.channel_name,
        message_count: activity.message_count
      });
    });
    
    // Add channel data to each user
    const usersWithChannels = users.map(user => ({
      ...user,
      channels: userChannels[user.user_id] || []
    }));
    
    res.json({
      snapshot,
      users: usersWithChannels
    });
  } catch (error) {
    console.error(`Error fetching snapshot data: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch snapshot data' });
  }
});

// Start the Discord bot and Express server
async function main() {
  try {
    // Initialize database
    db = await initDatabase();
    
    // Create Discord client
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
    });

    client.once(Events.ClientReady, async () => {
      console.log(`Bot ${client.user.tag} is ready!`);
      console.log(`Monitoring roles: ${TARGET_ROLES.join(", ")}`);
      console.log(`Monitoring channels: ${CHANNEL_IDS.length}`);
      
      await printStats(db);
      setupAutomaticSnapshots(db);
    });
    
    client.on(Events.MessageCreate, async (message) => {
      await processMessage(db, message);
    });
    
    client.on(Events.Error, (error) => {
      console.error(`Discord client error: ${error.message}`);
    });
    
    // Start Express server
    app.listen(PORT, () => {
      console.log(`Express server running on port ${PORT}`);
    });
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('Received termination signal, creating final snapshot...');
      await createSnapshot(db);
      console.log('Shutting down...');
      client.destroy();
      process.exit(0);
    });
    
    // Login to Discord
    await client.login(process.env.DISCORD_TOKEN);
    
  } catch (error) {
    console.error(`Critical error: ${error.message}`);
    process.exit(1);
  }
}

main(); 