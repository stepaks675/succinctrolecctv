import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from 'dotenv';
dotenv.config();

const DB_PATH = "/app/data/role_monitoring.db";
const TARGET_ROLES = ["Super Prover", "Proofer", "PROVED UR LUV", "Prover", "PROOF OF ART", "PROOF OF DEV", "PROOF OF MUSIC", "PROOF OF WRITING", "PROOF OF VIDEO", "Proof Verified"]; // Роли, которые нужно отслеживать


async function initDatabase() {
  console.log("Инициализация базы данных...");
  
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });
  await db.run("PRAGMA journal_mode = WAL");
  await db.run("PRAGMA cache_size = -10000"); 
  await db.run("PRAGMA synchronous = NORMAL");
  await db.run("PRAGMA temp_store = MEMORY");
  await db.run("PRAGMA busy_timeout = 5000");

  await db.run(`
    CREATE TABLE IF NOT EXISTS channel_activity (
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      roles TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      last_message TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, channel_id)
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name)
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS snapshot_data (
      snapshot_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      roles TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, user_id, channel_id),
      FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
    )
  `);

  await db.run("CREATE INDEX IF NOT EXISTS idx_channel_activity_user ON channel_activity(user_id)");
  await db.run("CREATE INDEX IF NOT EXISTS idx_channel_activity_channel ON channel_activity(channel_id)");
  await db.run("CREATE INDEX IF NOT EXISTS idx_snapshot_data_snapshot ON snapshot_data(snapshot_id)");
  await db.run("CREATE INDEX IF NOT EXISTS idx_snapshot_data_user ON snapshot_data(user_id)");

  console.log("База данных инициализирована успешно");
  return db;
}

function hasTargetRole(member) {
  if (!member || !member.roles) return false;
  
  return member.roles.cache.some(role => 
    TARGET_ROLES.includes(role.name)
  );
}

function getUserRoles(member) {
  if (!member || !member.roles) return "";
  
  const roles = member.roles.cache
    .filter(role => role.name !== "@everyone")
    .map(role => role.name)
    .join(", ");
  
  return roles;
}


async function processMessage(db, message) {

  if (message.author.bot) return;
  
  try {

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);

    if (!member || !hasTargetRole(member)) return;
    
    const userId = message.author.id;
    const username = message.author.tag;
    const roles = getUserRoles(member);
    const channelId = message.channel.id;
    const channelName = message.channel.name;
    
    await db.run(`
      INSERT INTO channel_activity (user_id, username, roles, channel_id, channel_name, message_count, last_message)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, channel_id) DO UPDATE SET
        username = ?,
        roles = ?,
        channel_name = ?,
        message_count = message_count + 1,
        last_message = CURRENT_TIMESTAMP
    `, [userId, username, roles, channelId, channelName, username, roles, channelName]);
    
    console.log(`[${new Date().toLocaleTimeString()}] Пользователь ${username} отправил сообщение в канале ${channelName}`);
    
  } catch (error) {
    console.error(`Ошибка при обработке сообщения: ${error.message}`);
  }
}

async function getRoleUserStats(db, limit = 20) {
  try {
    const users = await db.all(`
      SELECT 
        user_id, 
        username, 
        roles,
        SUM(message_count) as total_messages,
        MAX(last_message) as last_seen
      FROM channel_activity
      GROUP BY user_id
      ORDER BY total_messages DESC
      LIMIT ?
    `, [limit]);
    
    return users;
  } catch (error) {
    console.error(`Ошибка при получении статистики пользователей: ${error.message}`);
    return [];
  }
}

async function getUserChannelStats(db, userId) {
  try {
    const channels = await db.all(`
      SELECT 
        channel_id,
        channel_name,
        message_count,
        last_message
      FROM channel_activity
      WHERE user_id = ?
      ORDER BY message_count DESC
    `, [userId]);
    
    return channels;
  } catch (error) {
    console.error(`Ошибка при получении статистики каналов для пользователя ${userId}: ${error.message}`);
    return [];
  }
}

async function createSnapshot(db) {
  try {
    const now = new Date();
    const name = now.toISOString().replace(/[:.]/g, '-');
    
    console.log(`Создание снапшота "${name}"...`);
    
    await db.run("BEGIN TRANSACTION");
    
    try {
      const result = await db.run(`
        INSERT INTO snapshots (name, created_at)
        VALUES (?, CURRENT_TIMESTAMP)
      `, [name]);
      
      const snapshotId = result.lastID;
      
      const data = await db.all(`
        SELECT 
          user_id,
          username,
          roles,
          channel_id,
          channel_name,
          message_count
        FROM channel_activity
        ORDER BY user_id, message_count DESC
      `);
      
      if (data.length === 0) {
        console.log("Нет данных для снапшота");
        await db.run("ROLLBACK");
        return null;
      }
      
    
      const chunkSize = 1000;
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
        const values = [];
        
        for (const item of chunk) {
          values.push(
            snapshotId,
            item.user_id,
            item.username,
            item.roles,
            item.channel_id,
            item.channel_name,
            item.message_count
          );
        }
        
        await db.run(`
          INSERT INTO snapshot_data (
            snapshot_id, user_id, username, roles, channel_id, channel_name, message_count
          ) VALUES ${placeholders}
        `, values);
      }
      
      await db.run("COMMIT");
      
      console.log(`Снапшот "${name}" успешно создан (ID: ${snapshotId}, записей: ${data.length})`);
      
      return {
        id: snapshotId,
        name: name,
        count: data.length
      };
      
    } catch (error) {
      await db.run("ROLLBACK");
      console.error(`Ошибка при создании снапшота: ${error.message}`);
      return null;
    }
    
  } catch (error) {
    console.error(`Ошибка при создании снапшота: ${error.message}`);
    return null;
  }
}

async function cleanupOldSnapshots(db, keepCount = 100) {
  try {
    const snapshots = await db.all(`
      SELECT id
      FROM snapshots
      ORDER BY created_at DESC
    `);
    
    if (snapshots.length <= keepCount) {

      return;
    }

    const snapshotsToDelete = snapshots.slice(keepCount).map(s => s.id);
    
    console.log(`Удаление ${snapshotsToDelete.length} старых снапшотов...`);
    
    await db.run("BEGIN TRANSACTION");
    
    try {

      for (const id of snapshotsToDelete) {
        await db.run(`DELETE FROM snapshot_data WHERE snapshot_id = ?`, [id]);
        await db.run(`DELETE FROM snapshots WHERE id = ?`, [id]);
      }
      
      await db.run("COMMIT");
      
      console.log(`Удалено ${snapshotsToDelete.length} старых снапшотов`);
    } catch (error) {
      await db.run("ROLLBACK");
      console.error(`Ошибка при удалении старых снапшотов: ${error.message}`);
    }
  } catch (error) {
    console.error(`Ошибка при очистке старых снапшотов: ${error.message}`);
  }
}

async function getLastSnapshotTime(db) {
  try {
    const lastSnapshot = await db.get(`
      SELECT created_at
      FROM snapshots
      ORDER BY created_at DESC
      LIMIT 1
    `);
    
    return lastSnapshot ? new Date(lastSnapshot.created_at + 'Z') : null; // Adding 'Z' to treat the date as UTC
  } catch (error) {
    console.error(`Ошибка при получении времени последнего снапшота: ${error.message}`);
    return null;
  }
}

function setupAutomaticSnapshots(db) {
  const SNAPSHOT_INTERVAL = 1000 * 4 * 60 * 60
  
  console.log(`Настройка автоматического создания снапшотов каждые 4 часа`);
  
  (async () => {
    const lastSnapshotTime = await getLastSnapshotTime(db);
    let initialDelay = 0;
    
    if (lastSnapshotTime) {
      const now = new Date(Date.now() - (1 * 60 * 60 * 1000)); 
      const timeSinceLastSnapshot = now - lastSnapshotTime;
      
      if (timeSinceLastSnapshot < SNAPSHOT_INTERVAL) {
        initialDelay = SNAPSHOT_INTERVAL - timeSinceLastSnapshot;
        console.log(`Последний снепшот был создан ${Math.floor(timeSinceLastSnapshot / (1000 * 60))} минут назад. Следующий снепшот через ${Math.floor(initialDelay / (1000 * 60))} минут`);
      } else {
        console.log(`Последний снепшот был создан более 4 часов назад. Создаем новый снепшот сейчас`);
      }
    } else {
      console.log(`Снепшоты не найдены. Создаем первый снепшот`);
      await createSnapshot(db);
      await cleanupOldSnapshots(db);
    }
    
    setTimeout(() => {
      setInterval(async () => {
        console.log(`Запланированное создание снапшота...`);
        await createSnapshot(db);
        await cleanupOldSnapshots(db);
      }, SNAPSHOT_INTERVAL);
      (async () => {
        console.log(`Запланированное создание снапшота...`);
        await createSnapshot(db);
        await cleanupOldSnapshots(db);
      })();
    }, initialDelay);
    
  })();
}


export {
  TARGET_ROLES,
  initDatabase,
  hasTargetRole,
  getUserRoles,
  processMessage,
  getRoleUserStats,
  getUserChannelStats,
  createSnapshot,
  cleanupOldSnapshots,
  setupAutomaticSnapshots
};
