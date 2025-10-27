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

async function fetchExistingVideos() {
  console.log('Fetching existing videos from source channel...');
  
  try {
    let offset = 0;
    let fetchedCount = 0;
    const limit = 100;
    const newVideos = [];
    
    while (true) {
      try {
        const updates = await bot.telegram.getUpdates({
          offset: offset,
          limit: limit,
          timeout: 0
        });
        
        if (updates.length === 0) break;
        
        for (const update of updates) {
          if (update.channel_post && 
              update.channel_post.chat.id.toString() === SOURCE_CHANNEL_ID.toString() &&
              update.channel_post.video) {
            const messageId = update.channel_post.message_id;
            if (!allVideos.includes(messageId) && !newVideos.includes(messageId)) {
              newVideos.push(messageId);
            }
          }
          offset = update.update_id + 1;
        }
        
        if (updates.length < limit) break;
      } catch (error) {
        console.log('Reached end of available updates');
        break;
      }
    }
    
    // Alternative method: Try to get channel history directly
    try {
      let lastMessageId = null;
      const historyVideos = [];
      
      for (let i = 0; i < 10; i++) {
        const chat = await bot.telegram.getChat(SOURCE_CHANNEL_ID);
        
        // Try different message IDs
        const startId = lastMessageId || 1;
        const endId = startId + 100;
        
        for (let msgId = endId; msgId >= startId; msgId--) {
          try {
            const msg = await bot.telegram.forwardMessage(
              SOURCE_CHANNEL_ID,
              SOURCE_CHANNEL_ID,
              msgId
            ).catch(() => null);
            
            // If we can access the message, check if it's a video
            if (msg && msg.video) {
              if (!allVideos.includes(msgId) && !historyVideos.includes(msgId) && !newVideos.includes(msgId)) {
                historyVideos.push(msgId);
              }
            }
          } catch (e) {
            // Skip inaccessible messages
          }
        }
        
        if (historyVideos.length === 0) break;
        lastMessageId = endId;
      }
      
      newVideos.push(...historyVideos);
    } catch (error) {
      console.log('Channel history fetch method not available');
    }
    
    // Add all new videos
    for (const msgId of newVideos) {
      await saveVideo(msgId);
      fetchedCount++;
    }
    
    console.log(`Fetched ${fetchedCount} existing videos. Total videos: ${allVideos.length}`);
    
  } catch (error) {
    console.error('Error fetching existing videos:', error.message);
  }
}

async function scanChannelMessages() {
  console.log('Scanning source channel for video messages...');
  
  try {
    // Try to get recent messages by attempting to copy them
    const scannedVideos = [];
    const maxAttempts = 1000; // Scan last 1000 message IDs
    let foundCount = 0;
    
    // Get a recent message to find current message ID range
    try {
      const chat = await bot.telegram.getChat(SOURCE_CHANNEL_ID);
      console.log('Source channel info:', chat.title || chat.username);
    } catch (error) {
      console.log('Could not get channel info');
    }
    
    // Try scanning message IDs in reverse (most recent first)
    for (let i = 1; i <= maxAttempts; i++) {
      try {
        // Attempt to copy message to check if it exists and is a video
        const testChatId = SOURCE_CHANNEL_ID; // Use the channel itself
        
        // We'll try to get message info by attempting to forward/copy
        // This is a workaround since we can't directly read channel history
        await bot.telegram.copyMessage(
          testChatId,
          SOURCE_CHANNEL_ID,
          i
        ).then(async (msg) => {
          // If successful, delete the test message
          try {
            await bot.telegram.deleteMessage(testChatId, msg.message_id);
          } catch (e) {}
          
          // Check if original was a video
          if (!allVideos.includes(i) && !scannedVideos.includes(i)) {
            scannedVideos.push(i);
            foundCount++;
          }
        }).catch(() => {
          // Message doesn't exist or we can't access it
        });
        
      } catch (error) {
        // Skip this message ID
      }
      
      // Add delay to avoid rate limiting
      if (i % 20 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Save all found videos
    for (const msgId of scannedVideos) {
      await saveVideo(msgId);
    }
    
    console.log(`Scanned and found ${foundCount} videos. Total: ${allVideos.length}`);
    
  } catch (error) {
    console.error('Error scanning channel:', error.message);
  }
}

async function saveVideo(messageId) {
  if (allVideos.includes(messageId)) {
    return;
  }
  
  allVideos.push(messageId);
  allVideos.sort((a, b) => a - b); // Keep sorted
  
  if (db && videosCollection) {
    try {
      await videosCollection.insertOne({ messageId, addedAt: new Date() });
    } catch (error) {
      // Ignore duplicate errors
    }
  }
  
  console.log('Video saved:', messageId, '| Total:', allVideos.length);
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
    await ctx.reply('❌ No videos available. Add bot as admin to your channel and post videos.');
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
    await ctx.reply('❌ Error sending video. Try again.');
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
    `Use /newvideo to start`
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

bot.command('sync', async (ctx) => {
  const userId = ctx.from.id;
  
  // Only allow bot admin to sync
  try {
    const member = await ctx.telegram.getChatMember(SOURCE_CHANNEL_ID, userId);
    if (!['creator', 'administrator'].includes(member.status)) {
      await ctx.reply('❌ Only channel admins can sync videos.');
      return;
    }
  } catch (error) {
    await ctx.reply('❌ Only channel admins can sync videos.');
    return;
  }
  
  await ctx.reply('🔄 Syncing videos from channel... This may take a moment.');
  
  await fetchExistingVideos();
  
  await ctx.reply(`✅ Sync complete!\n📊 Total videos: ${allVideos.length}`);
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
    videos: allVideos.length
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function main() {
  try {
    await initMongo();
    
    await bot.launch();
    console.log('Bot started!');
    
    // Attempt to fetch existing videos from channel
    console.log('Attempting to sync existing videos...');
    await fetchExistingVideos();
    
    if (allVideos.length === 0) {
      console.log('⚠️ No videos found. Videos will be tracked as they are posted to the channel.');
      console.log('💡 TIP: Use /sync command in the bot (as channel admin) to manually trigger sync.');
    }
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

main();
