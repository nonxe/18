const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SOURCE_CHANNEL_ID = process.env.SOURCE_CHANNEL_ID;
const FORCE_JOIN_CHANNEL_USERNAME = process.env.FORCE_JOIN_CHANNEL_USERNAME;
const MONGO_URL = process.env.MONGO_URL;
const PORT = process.env.PORT || 8443;

if (!BOT_TOKEN || !SOURCE_CHANNEL_ID || !FORCE_JOIN_CHANNEL_USERNAME) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

let db = null;
let userDataCollection = null;
let videosCollection = null;
const inMemoryUsers = new Map();
let allVideos = [];

app.use(express.json());

async function initMongo() {
  if (!MONGO_URL) {
    console.log('Using in-memory storage');
    return;
  }
  
  try {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    db = client.db('telegram_bot');
    userDataCollection = db.collection('users');
    videosCollection = db.collection('videos');
    
    const videos = await videosCollection.find({}).sort({ messageId: 1 }).toArray();
    allVideos = videos.map(v => v.messageId);
    
    console.log('MongoDB connected. Videos loaded:', allVideos.length);
  } catch (error) {
    console.error('MongoDB failed, using in-memory:', error);
    db = null;
  }
}

// Ye function channel ke saare purane videos fetch karega
async function fetchAllChannelVideos() {
  console.log('🔍 Fetching all videos from source channel...');
  
  try {
    let foundVideos = [];
    let offsetId = 0;
    let attempts = 0;
    const maxAttempts = 50; // Max 5000 messages check karenge (50 * 100)
    
    while (attempts < maxAttempts) {
      try {
        // Channel se messages fetch karo - requires bot to be admin
        const messages = await bot.telegram.callApi('getChat', {
          chat_id: SOURCE_CHANNEL_ID
        }).catch(() => null);
        
        // Try different approach - iterate through message IDs
        let foundInBatch = 0;
        const batchSize = 100;
        const startId = offsetId + 1;
        const endId = startId + batchSize;
        
        console.log(`Checking message IDs ${startId} to ${endId}...`);
        
        for (let msgId = startId; msgId < endId; msgId++) {
          try {
            // Try to copy message to check if it exists
            const msg = await bot.telegram.copyMessage(
              SOURCE_CHANNEL_ID,
              SOURCE_CHANNEL_ID,
              msgId
            );
            
            // Delete the copied message immediately
            await bot.telegram.deleteMessage(SOURCE_CHANNEL_ID, msg.message_id).catch(() => {});
            
            // Original message exists, ab check karo video hai ya nahi
            // Hum assume karenge agar copy successful hai to it might be a video
            if (!allVideos.includes(msgId) && !foundVideos.includes(msgId)) {
              foundVideos.push(msgId);
              foundInBatch++;
              console.log(`✓ Found video at message ID: ${msgId}`);
            }
            
          } catch (error) {
            // Message doesn't exist or not accessible, skip
          }
          
          // Rate limiting ke liye delay
          if (msgId % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        
        offsetId = endId;
        attempts++;
        
        // Agar kuch bhi nahi mila to break
        if (foundInBatch === 0 && attempts > 5) {
          console.log('No more messages found, stopping scan.');
          break;
        }
        
      } catch (error) {
        console.log('Batch scan completed or error:', error.message);
        break;
      }
      
      // Har batch ke baad thoda wait karo
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Save all found videos
    for (const msgId of foundVideos) {
      await saveVideo(msgId);
    }
    
    console.log(`✅ Scan complete! Found ${foundVideos.length} videos. Total: ${allVideos.length}`);
    
  } catch (error) {
    console.error('❌ Error fetching channel videos:', error.message);
    console.log('💡 Make sure bot is admin in the source channel!');
  }
}

// Better approach using manual message ID input
async function loadInitialVideos() {
  console.log('📥 Loading existing videos...');
  
  // Agar database me already videos hai to wo load ho jayengi
  if (allVideos.length > 0) {
    console.log(`✅ ${allVideos.length} videos loaded from database`);
    return;
  }
  
  // Nahi to channel scan karo
  console.log('🔄 Starting channel scan for videos...');
  
  try {
    // Method 1: Try to get channel info first
    const chat = await bot.telegram.getChat(SOURCE_CHANNEL_ID);
    console.log(`📺 Channel: ${chat.title || 'Private Channel'}`);
    
    // Method 2: Intelligent message ID scanning
    // Start from message ID 1 and scan upwards
    let consecutiveFailures = 0;
    let maxConsecutiveFailures = 50; // Agar 50 consecutive IDs pe video nahi mili to stop
    let currentId = 1;
    let maxId = 10000; // Maximum 10000 messages check karenge
    
    console.log('🔍 Scanning messages (this may take a few minutes)...');
    
    for (let msgId = currentId; msgId <= maxId; msgId++) {
      try {
        // Try to forward message to same channel (test if exists)
        await bot.telegram.forwardMessage(
          SOURCE_CHANNEL_ID,
          SOURCE_CHANNEL_ID,
          msgId
        ).then(async (forwardedMsg) => {
          // Delete the forwarded message
          await bot.telegram.deleteMessage(SOURCE_CHANNEL_ID, forwardedMsg.message_id).catch(() => {});
          
          // Message exists! Assume it might be a video
          if (!allVideos.includes(msgId)) {
            await saveVideo(msgId);
            consecutiveFailures = 0;
            console.log(`✓ Found message ${msgId} (Total videos: ${allVideos.length})`);
          }
        }).catch(() => {
          consecutiveFailures++;
        });
        
      } catch (error) {
        consecutiveFailures++;
      }
      
      // Agar bahut saare consecutive failures ho gaye to break
      if (consecutiveFailures >= maxConsecutiveFailures) {
        console.log(`⏭️ Skipping ahead due to consecutive failures...`);
        // Jump ahead by 100 and reset counter
        msgId += 100;
        consecutiveFailures = 0;
        
        // But if we're already far ahead, just stop
        if (msgId > maxId - 500) {
          break;
        }
      }
      
      // Rate limiting
      if (msgId % 20 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`Progress: Checked ${msgId} message IDs...`);
      }
    }
    
    console.log(`✅ Initial scan complete! Total videos found: ${allVideos.length}`);
    
  } catch (error) {
    console.error('Error during initial video load:', error.message);
  }
}

async function saveVideo(messageId) {
  if (allVideos.includes(messageId)) {
    return;
  }
  
  allVideos.push(messageId);
  allVideos.sort((a, b) => a - b);
  
  if (db && videosCollection) {
    try {
      await videosCollection.insertOne({ messageId, addedAt: new Date() });
    } catch (error) {
      // Ignore duplicate errors
    }
  }
}

async function getUserIndex(userId) {
  if (db && userDataCollection) {
    try {
      const user = await userDataCollection.findOne({ userId });
      return user ? user.currentIndex : 0;
    } catch (error) {
      return 0;
    }
  } else {
    if (!inMemoryUsers.has(userId)) {
      inMemoryUsers.set(userId, 0);
    }
    return inMemoryUsers.get(userId);
  }
}

async function setUserIndex(userId, index) {
  if (db && userDataCollection) {
    try {
      await userDataCollection.updateOne(
        { userId },
        { $set: { currentIndex: index } },
        { upsert: true }
      );
    } catch (error) {
      console.error('Error saving user index:', error);
    }
  } else {
    inMemoryUsers.set(userId, index);
  }
}

async function checkMembership(ctx, userId) {
  try {
    const member = await ctx.telegram.getChatMember(`@${FORCE_JOIN_CHANNEL_USERNAME}`, userId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (error) {
    return false;
  }
}

async function showJoinMessage(ctx) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('Join Channel', `https://t.me/${FORCE_JOIN_CHANNEL_USERNAME}`)],
    [Markup.button.callback('✅ Retry', 'retry_join')]
  ]);
  
  await ctx.reply(
    `⚠️ Please join @${FORCE_JOIN_CHANNEL_USERNAME} to use this bot.`,
    keyboard
  );
}

async function sendNextVideo(ctx, userId) {
  if (allVideos.length === 0) {
    await ctx.reply('❌ No videos available yet.\n\n💡 Tips:\n1. Make bot admin in source channel\n2. Use /rescan to scan for videos\n3. Post new videos');
    return;
  }
  
  let currentIndex = await getUserIndex(userId);
  
  if (currentIndex >= allVideos.length) {
    currentIndex = 0;
  }
  
  const videoMessageId = allVideos[currentIndex];
  
  try {
    await ctx.telegram.copyMessage(
      ctx.chat.id,
      SOURCE_CHANNEL_ID,
      videoMessageId,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '▶️ Next Video', callback_data: 'next_video' }
          ]]
        }
      }
    );
    
    const nextIndex = (currentIndex + 1) % allVideos.length;
    await setUserIndex(userId, nextIndex);
    
    console.log(`Sent video ${videoMessageId} to user ${userId} (${currentIndex + 1}/${allVideos.length})`);
  } catch (error) {
    console.error('Error sending video:', error);
    await ctx.reply('❌ Error sending video. It may have been deleted from the channel.');
    
    // Try next video automatically
    const nextIndex = (currentIndex + 1) % allVideos.length;
    await setUserIndex(userId, nextIndex);
  }
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  
  const isMember = await checkMembership(ctx, userId);
  if (!isMember) {
    await showJoinMessage(ctx);
    return;
  }
  
  await ctx.reply(
    `👋 Welcome!\n\n` +
    `🔄 Videos repeat in a cycle\n` +
    `📊 Available videos: ${allVideos.length}\n\n` +
    `Commands:\n` +
    `/newvideo - Get next video\n` +
    `/rescan - Rescan channel for videos (admin only)`
  );
});

bot.command('newvideo', async (ctx) => {
  const userId = ctx.from.id;
  
  const isMember = await checkMembership(ctx, userId);
  if (!isMember) {
    await showJoinMessage(ctx);
    return;
  }
  
  await sendNextVideo(ctx, userId);
});

// Rescan command - channel admin only
bot.command('rescan', async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    const member = await ctx.telegram.getChatMember(SOURCE_CHANNEL_ID, userId);
    if (!['creator', 'administrator'].includes(member.status)) {
      await ctx.reply('❌ Only channel admins can rescan.');
      return;
    }
  } catch (error) {
    await ctx.reply('❌ Only channel admins can rescan.');
    return;
  }
  
  await ctx.reply('🔄 Rescanning channel for videos...\n\nThis will take a few minutes. I will notify you when complete.');
  
  const beforeCount = allVideos.length;
  await loadInitialVideos();
  const afterCount = allVideos.length;
  const newVideos = afterCount - beforeCount;
  
  await ctx.reply(
    `✅ Rescan complete!\n\n` +
    `📊 Total videos: ${afterCount}\n` +
    `🆕 New videos found: ${newVideos}`
  );
});

// Admin command to manually add video message IDs
bot.command('addvideo', async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    const member = await ctx.telegram.getChatMember(SOURCE_CHANNEL_ID, userId);
    if (!['creator', 'administrator'].includes(member.status)) {
      await ctx.reply('❌ Only channel admins can add videos.');
      return;
    }
  } catch (error) {
    await ctx.reply('❌ Only channel admins can add videos.');
    return;
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length === 0) {
    await ctx.reply('Usage: /addvideo <message_id1> <message_id2> ...\n\nExample: /addvideo 123 124 125');
    return;
  }
  
  let added = 0;
  for (const arg of args) {
    const msgId = parseInt(arg);
    if (!isNaN(msgId)) {
      await saveVideo(msgId);
      added++;
    }
  }
  
  await ctx.reply(`✅ Added ${added} video(s).\nTotal videos: ${allVideos.length}`);
});

bot.action('next_video', async (ctx) => {
  await ctx.answerCbQuery();
  
  const userId = ctx.from.id;
  
  const isMember = await checkMembership(ctx, userId);
  if (!isMember) {
    await showJoinMessage(ctx);
    return;
  }
  
  await sendNextVideo(ctx, userId);
});

bot.action('retry_join', async (ctx) => {
  const userId = ctx.from.id;
  
  const isMember = await checkMembership(ctx, userId);
  if (!isMember) {
    await ctx.answerCbQuery('❌ Still need to join!', { show_alert: true });
    return;
  }
  
  await ctx.answerCbQuery('✅ Success!');
  await ctx.editMessageText('✅ You can now use /newvideo');
});

bot.on('channel_post', async (ctx) => {
  try {
    if (ctx.channelPost.chat.id.toString() === SOURCE_CHANNEL_ID.toString()) {
      if (ctx.channelPost.video) {
        await saveVideo(ctx.channelPost.message_id);
        console.log(`📹 New video posted: ${ctx.channelPost.message_id}`);
      }
    }
  } catch (error) {
    console.error('Error processing post:', error);
  }
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    videos: allVideos.length,
    mongodb: db ? 'connected' : 'in-memory'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function main() {
  try {
    await initMongo();
    
    await bot.launch();
    console.log('✅ Bot started successfully!');
    
    // Load existing videos on startup
    if (allVideos.length === 0) {
      console.log('🔄 No videos in database, starting initial scan...');
      console.log('⚠️ This may take several minutes...');
      
      // Start scan in background to not block the bot
      setTimeout(() => {
        loadInitialVideos();
      }, 5000);
    } else {
      console.log(`📊 ${allVideos.length} videos ready!`);
    }
    
    app.listen(PORT, () => {
      console.log(`🌐 Server running on port ${PORT}`);
    });
    
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

main();
