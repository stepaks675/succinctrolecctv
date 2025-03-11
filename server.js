import express from 'express';
import cors from 'cors';
import { Client, GatewayIntentBits, Events } from "discord.js";
import dotenv from 'dotenv';

dotenv.config();


const DB_PATH = "./app/data/role_monitoring.db";
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'default-api-key';


const app = express();
app.use(cors());
app.use(express.json());


const apiKeyAuth = (req, res, next) => {
  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
  }
  next();
};


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


app.get('/', (req, res) => {
  res.json({ status: 'Discord Bot API is running' });
});


app.delete('/api/snapshots/:id', apiKeyAuth, async (req, res) => {
  try {
    const snapshotId = parseInt(req.params.id);

    const snapshot = await db.get(`
      SELECT id FROM snapshots WHERE id = ?
    `, [snapshotId]);
    
    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    

    const maxIdResult = await db.get(`SELECT MAX(id) as maxId FROM snapshots`);
    const isLastSnapshot = snapshotId === maxIdResult.maxId;
    
    await db.run("BEGIN TRANSACTION");
    
    try {
      await db.run(`DELETE FROM snapshot_data WHERE snapshot_id = ?`, [snapshotId]);
      
      await db.run(`DELETE FROM snapshots WHERE id = ?`, [snapshotId]);
      
      if (isLastSnapshot) {
        console.log(`Resetting autoincrement counter after deleting last snapshot (ID: ${snapshotId})`);
        
        const newMaxIdResult = await db.get(`SELECT MAX(id) as maxId FROM snapshots`);
        const newMaxId = newMaxIdResult.maxId || 0;
        
        await db.run(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'snapshots'`, [newMaxId]);
        
        console.log(`Autoincrement counter reset to ${newMaxId}`);
      }
      
      await db.run("COMMIT");
      
      console.log(`Snapshot with ID ${snapshotId} has been deleted`);
      res.json({ 
        success: true, 
        message: `Snapshot with ID ${snapshotId} has been deleted`,
        autoIncrementReset: isLastSnapshot
      });
    } catch (error) {
      await db.run("ROLLBACK");
      console.error(`Error during snapshot deletion: ${error.message}`);
      res.status(500).json({ error: 'Failed to delete snapshot' });
    }
  } catch (error) {
    console.error(`Error deleting snapshot: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete snapshot' });
  }
});

app.get('/api/snapshots/:id?', apiKeyAuth, async (req, res) => {
  try {
    const snapshotId = req.params.id;
    
    if (!snapshotId) {
      const snapshots = await db.all(`
        SELECT id, name, created_at, 
        (SELECT COUNT(*) FROM snapshot_data WHERE snapshot_id = snapshots.id) as record_count
        FROM snapshots
        ORDER BY created_at DESC
      `);
      
      return res.json(snapshots);
    }
    
    const snapshot = await db.get(`
      SELECT id, name, created_at
      FROM snapshots
      WHERE id = ?
    `, [snapshotId]);
    
    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }
    
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


async function main() {
  try {

    db = await initDatabase();
    

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
  
      await printStats(db);
      setupAutomaticSnapshots(db);
    });
    
    client.on(Events.MessageCreate, async (message) => {
      await processMessage(db, message);
    });
    
    client.on(Events.Error, (error) => {
      console.error(`Discord client error: ${error.message}`);
    });
    

    app.listen(PORT, () => {
      console.log(`Express server running on port ${PORT}`);
    });
    
  
    process.on('SIGINT', async () => {
      console.log('Received termination signal, creating final snapshot...');
      await createSnapshot(db);
      console.log('Shutting down...');
      client.destroy();
      process.exit(0);
    });
    

    await client.login(process.env.DISCORD_TOKEN);
    
  } catch (error) {
    console.error(`Critical error: ${error.message}`);
    process.exit(1);
  }
}

main(); 