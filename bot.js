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
let watchHistoryCollection = null;
let channelVideosCollection = null;
const inMemoryHistory = new Map();
let channelVideos = [];
let isIndexingComplete = false;

app.use(express.json());

async function initMongo() {
  if (!MONGO_URL) {
    console.log('No MONGO_URL provided, using in-memory storage');
    return;
  }
  
  try {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    db = client.db('telegram_bot');
    watchHistoryCollection = db.collection('watch_history');
    channelVideosCollection = db.collection('channel_videos');
    
    await watchHistoryCollection.createIndex({ userId: 1 });
    await channelVideosCollection.createIndex({ messageId: 1 }, { unique: true });
    await channelVideosCollection.createIndex({ date: -1 });
    
    const videos = await channelVideosCollection.find({}).sort({ date: -1 }).toArray();
    channelVideos = videos.map(v => v.messageId);
    
    console.log('MongoDB connected, loaded', channelVideos.length, 'existing videos');
  } catch (error) {
    console.error('MongoDB connection failed, using in-memory storage:', error);
    db = null;
  }
}

async function scanChannelMessages() {
  console.log('=== Starting Complete Channel Scan ===');
  console.log('This will fetch ALL videos from the channel...');
  
  let totalFound = 0;
  let lastMessageId = 1;
  const batchSize = 50;
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 100;
  
  try {
    while (consecutiveFailures < maxConsecutiveFailures) {
      const promises = [];
      
      for (let i = 0; i < batchSize; i++) {
        const messageId = lastMessageId + i;
        
        promises.push(
          bot.telegram.copyMessage(
            BOT_TOKEN.split(':')[0],
            SOURCE_CHANNEL_ID,
            messageId
          ).then(async (result) => {
            consecutiveFailures = 0;
            
            try {
              const message = await bot.telegram.getMessage(SOURCE_CHANNEL_ID, messageId);
              
              if (message && message.video) {
                await addChannelVideo(messageId, message.date, true);
                totalFound++;
                
                if (totalFound % 10 === 0) {
                  console.log(`✓ Found ${totalFound} videos so far...`);
                }
              }
            } catch (err) {
              // Message doesn't exist or not accessible
            }
            
            return true;
          }).catch(() => {
            consecutiveFailures++;
            return false;
          })
        );
      }
      
      await Promise.allSettled(promises);
      
      lastMessageId += batchSize;
      
      if (lastMessageId % 500 === 0) {
        console.log(`Scanned up to message ID ${lastMessageId}...`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`=== Scan Complete: Found ${totalFound} videos ===`);
    console.log(`Total videos in database: ${channelVideos.length}`);
    
  } catch (error) {
    console.error('Error during channel scan:', error);
  }
  
  isIndexingComplete = true;
}

async function smartIndexChannelVideos() {
  console.log('=== Starting Smart Video Indexing ===');
  
  let foundVideos = 0;
  let maxMessageId = 0;
  
  try {
    console.log('Method 1: Trying to get channel info...');
    
    try {
      const chat = await bot.telegram.getChat(SOURCE_CHANNEL_ID);
      console.log('Channel info:', chat.title);
    } catch (err) {
      console.log('Could not get channel info:', err.message);
    }
    
    console.log('Method 2: Binary search for highest message ID...');
    
    let low = 1;
    let high = 1000000;
    let foundHigh = 1;
    
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      
      try {
        await bot.telegram.forwardMessage(
          BOT_TOKEN.split(':')[0],
          SOURCE_CHANNEL_ID,
          mid
        );
        
        foundHigh = mid;
        low = mid + 1;
        console.log(`✓ Message ${mid} exists, searching higher...`);
      } catch (err) {
        high = mid - 1;
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    maxMessageId = foundHigh;
    console.log(`Highest message ID found: ${maxMessageId}`);
    
    console.log('Method 3: Scanning backwards from highest message...');
    
    let consecutiveFailures = 0;
    const maxFailures = 200;
    
    for (let messageId = maxMessageId; messageId >= 1 && consecutiveFailures < maxFailures; messageId--) {
      try {
        const copiedMessage = await bot.telegram.copyMessage(
          BOT_TOKEN.split(':')[0],
          SOURCE_CHANNEL_ID,
          messageId
        );
        
        if (copiedMessage) {
          consecutiveFailures = 0;
          
          try {
            await bot.telegram.deleteMessage(BOT_TOKEN.split(':')[0], copiedMessage.message_id);
          } catch (e) {
            // Ignore delete errors
          }
          
          try {
            const actualMessage = await bot.telegram.copyMessage(
              SOURCE_CHANNEL_ID,
              SOURCE_CHANNEL_ID,
              messageId
            );
            
            if (actualMessage) {
              const msg = await bot.telegram.getMessage(SOURCE_CHANNEL_ID, actualMessage.message_id);
              
              if (msg && msg.video) {
                await addChannelVideo(messageId, msg.date || Date.now(), true);
                foundVideos++;
                
                if (foundVideos % 5 === 0) {
                  console.log(`✓ Found ${foundVideos} videos (at message ${messageId})`);
                }
              }
              
              try {
                await bot.telegram.deleteMessage(SOURCE_CHANNEL_ID, actualMessage.message_id);
              } catch (e) {
                // Ignore
              }
            }
          } catch (e) {
            // Not a video or can't forward
          }
        }
      } catch (err) {
        consecutiveFailures++;
      }
      
      if (messageId % 50 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    console.log(`=== Indexing Complete ===`);
    console.log(`Found ${foundVideos} videos`);
    console.log(`Total videos in database: ${channelVideos.length}`);
    
  } catch (error) {
    console.error('Error during smart indexing:', error);
  }
  
  if (channelVideos.length === 0) {
    console.log('Warning: No videos found. Will only track new videos posted after bot start.');
  }
  
  isIndexingComplete = true;
}

async function addChannelVideo(messageId, date, skipLog = false) {
  const exists = channelVideos.includes(messageId);
  
  if (exists) {
    return;
  }
  
  if (db && channelVideosCollection) {
    try {
      await channelVideosCollection.updateOne(
        { messageId },
        { $set: { messageId, date } },
        { upsert: true }
      );
      
      channelVideos.push(messageId);
      channelVideos.sort((a, b) => b - a);
      
      if (!skipLog) {
        console.log(`✓ Video ${messageId} added. Total: ${channelVideos.length}`);
      }
    } catch (error) {
      if (!error.message.includes('duplicate key')) {
        console.error('Error adding to MongoDB:', error);
      }
    }
  } else {
    channelVideos.push(messageId);
    channelVideos.sort((a, b) => b - a);
    
    if (!skipLog) {
      console.log(`✓ Video ${messageId} added to memory. Total: ${channelVideos.length}`);
    }
  }
}

async function getNextVideoIndex(userId) {
  if (db && watchHistoryCollection) {
    try {
      const record = await watchHistoryCollection.findOne({ userId });
      return record && record.currentIndex !== undefined ? record.currentIndex : 0;
    } catch (error) {
      return 0;
    }
  } else {
    const key = `user_${userId}`;
    if (!inMemoryHistory.has(key)) {
      inMemoryHistory.set(key, { currentIndex: 0, watchedVideos: new Set() });
    }
    return inMemoryHistory.get(key).currentIndex;
  }
}

async function updateNextVideoIndex(userId, newIndex) {
  if (db && watchHistoryCollection) {
    try {
      await watchHistoryCollection.updateOne(
        { userId },
        { $set: { currentIndex: newIndex } },
        { upsert: true }
      );
    } catch (error) {
      console.error('Error updating index:', error);
    }
  } else {
    const key = `user_${userId}`;
    if (!inMemoryHistory.has(key)) {
      inMemoryHistory.set(key, { currentIndex: 0, watchedVideos: new Set() });
    }
    inMemoryHistory.get(key).currentIndex = newIndex;
  }
}

async function saveWatchHistory(userId, messageId) {
  if (db && watchHistoryCollection) {
    try {
      await watchHistoryCollection.updateOne(
        { userId },
        { $addToSet: { watchedVideos: messageId } },
        { upsert: true }
      );
    } catch (error) {
      console.error('Error saving history:', error);
    }
  } else {
    const key = `user_${userId}`;
    if (!inMemoryHistory.has(key)) {
      inMemoryHistory.set(key, { currentIndex: 0, watchedVideos: new Set() });
    }
    inMemoryHistory.get(key).watchedVideos.add(messageId);
  }
}

async function checkUserMembership(ctx, userId) {
  try {
    const member = await ctx.telegram.getChatMember(`@${FORCE_JOIN_CHANNEL_USERNAME}`, userId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (error) {
    console.error('Membership check error:', error);
    return false;
  }
}

async function showJoinPrompt(ctx) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('Join Channel', `https://t.me/${FORCE_JOIN_CHANNEL_USERNAME}`)],
    [Markup.button.callback('✅ I Joined - Retry', 'retry_join')]
  ]);
  
  await ctx.reply(
    `⚠️ You must join our channel to use this bot.\n\nPlease join @${FORCE_JOIN_CHANNEL_USERNAME} and then click the Retry button below.`,
    keyboard
  );
}

async function getNextVideo(userId) {
  if (channelVideos.length === 0) {
    return null;
  }
  
  let currentIndex = await getNextVideoIndex(userId);
  
  if (currentIndex >= channelVideos.length) {
    currentIndex = 0;
  }
  
  const videoId = channelVideos[currentIndex];
  
  const nextIndex = (currentIndex + 1) % channelVideos.length;
  await updateNextVideoIndex(userId, nextIndex);
  
  return videoId;
}

async function forwardNextVideo(ctx, userId) {
  if (!isIndexingComplete) {
    await ctx.reply('⏳ Bot is indexing all videos from the channel. Please wait 1-2 minutes and try again...');
    return;
  }
  
  if (channelVideos.length === 0) {
    await ctx.reply('📭 No videos found in the channel. Please make sure the bot is added as admin in the source channel and has permission to see messages.');
    return;
  }
  
  const nextVideoId = await getNextVideo(userId);
  
  if (!nextVideoId) {
    await ctx.reply('❌ Unable to get video. Please try again.');
    return;
  }
  
  try {
    await ctx.telegram.copyMessage(
      ctx.chat.id,
      SOURCE_CHANNEL_ID,
      nextVideoId,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '▶️ Next Video', callback_data: 'next_video' }
          ]]
        }
      }
    );
    
    await saveWatchHistory(userId, nextVideoId);
    console.log(`Sent video ${nextVideoId} to user ${userId}`);
  } catch (error) {
    console.error('Error forwarding video:', error);
    await ctx.reply('❌ Error sending video. The video might have been deleted from the channel.');
  }
}

bot.start(async (ctx) => {
  console.log('/start from user:', ctx.from.id);
  const userId = ctx.from.id;
  
  const isMember = await checkUserMembership(ctx, userId);
  if (!isMember) {
    await showJoinPrompt(ctx);
    return;
  }
  
  const statusMsg = isIndexingComplete 
    ? `📊 ${channelVideos.length} videos available`
    : '⏳ Still indexing videos...';
  
  await ctx.reply(
    `👋 Welcome to the Video Bot!\n\n` +
    `🔄 Videos play in an endless cycle - they never run out!\n\n` +
    `Use /newvideo to get your next video.\n\n${statusMsg}`
  );
});

bot.command('newvideo', async (ctx) => {
  console.log('/newvideo from user:', ctx.from.id);
  const userId = ctx.from.id;
  
  const isMember = await checkUserMembership(ctx, userId);
  if (!isMember) {
    await showJoinPrompt(ctx);
    return;
  }
  
  await forwardNextVideo(ctx, userId);
});

bot.action('next_video', async (ctx) => {
  console.log('next_video from user:', ctx.from.id);
  const userId = ctx.from.id;
  
  const isMember = await checkUserMembership(ctx, userId);
  if (!isMember) {
    await ctx.answerCbQuery();
    await showJoinPrompt(ctx);
    return;
  }
  
  await ctx.answerCbQuery();
  await forwardNextVideo(ctx, userId);
});

bot.action('retry_join', async (ctx) => {
  console.log('retry_join from user:', ctx.from.id);
  const userId = ctx.from.id;
  
  const isMember = await checkUserMembership(ctx, userId);
  if (!isMember) {
    await ctx.answerCbQuery('❌ You still need to join the channel!', { show_alert: true });
    return;
  }
  
  await ctx.answerCbQuery('✅ Success! You can now use the bot.', { show_alert: true });
  await ctx.editMessageText(
    '✅ Great! You\'re now a member. Use /newvideo to get started!',
    Markup.inlineKeyboard([])
  );
});

bot.on('channel_post', async (ctx) => {
  try {
    if (ctx.channelPost.chat.id.toString() === SOURCE_CHANNEL_ID.toString()) {
      if (ctx.channelPost.video) {
        const messageId = ctx.channelPost.message_id;
        const date = ctx.channelPost.date;
        await addChannelVideo(messageId, date);
        console.log(`New video posted: ${messageId}. Total: ${channelVideos.length}`);
      }
    }
  } catch (error) {
    console.error('Error processing channel post:', error);
  }
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    videos: channelVideos.length,
    storage: db ? 'MongoDB' : 'In-Memory',
    indexing_complete: isIndexingComplete
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    videos: channelVideos.length,
    indexing: isIndexingComplete
  });
});

async function main() {
  try {
    console.log('Starting bot...');
    await initMongo();
    
    console.log('Launching bot...');
    await bot.launch();
    console.log('Bot is live!');
    
    setTimeout(() => {
      console.log('Starting video indexing in background...');
      smartIndexChannelVideos().catch(err => {
        console.error('Indexing error:', err);
        isIndexingComplete = true;
      });
    }, 5000);
    
    app.listen(PORT, () => {
      console.log(`Server on port ${PORT}`);
    });
    
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
}

main();
