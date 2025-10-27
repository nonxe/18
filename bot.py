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
    
    console.log('MongoDB connected successfully, loaded', channelVideos.length, 'videos');
  } catch (error) {
    console.error('MongoDB connection failed, using in-memory storage:', error);
    db = null;
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
      console.error('Error saving to MongoDB:', error);
    }
  } else {
    if (!inMemoryHistory.has(userId)) {
      inMemoryHistory.set(userId, new Set());
    }
    inMemoryHistory.get(userId).add(messageId);
  }
}

async function getWatchHistory(userId) {
  if (db && watchHistoryCollection) {
    try {
      const record = await watchHistoryCollection.findOne({ userId });
      return record ? new Set(record.watchedVideos) : new Set();
    } catch (error) {
      console.error('Error reading from MongoDB:', error);
      return new Set();
    }
  } else {
    return inMemoryHistory.get(userId) || new Set();
  }
}

async function addChannelVideo(messageId, date) {
  if (db && channelVideosCollection) {
    try {
      await channelVideosCollection.updateOne(
        { messageId },
        { $set: { messageId, date } },
        { upsert: true }
      );
      
      const videos = await channelVideosCollection.find({}).sort({ date: -1 }).toArray();
      channelVideos = videos.map(v => v.messageId);
      console.log('Video added to database. Total videos:', channelVideos.length);
    } catch (error) {
      console.error('Error adding video to MongoDB:', error);
      if (!channelVideos.includes(messageId)) {
        channelVideos.unshift(messageId);
      }
    }
  } else {
    if (!channelVideos.includes(messageId)) {
      channelVideos.unshift(messageId);
      console.log('Video added to memory. Total videos:', channelVideos.length);
    }
  }
}

async function checkUserMembership(ctx, userId) {
  try {
    const member = await ctx.telegram.getChatMember(`@${FORCE_JOIN_CHANNEL_USERNAME}`, userId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (error) {
    console.error('Error checking membership:', error);
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

async function getNextUnwatchedVideo(userId) {
  const watchedVideos = await getWatchHistory(userId);
  
  for (const messageId of channelVideos) {
    if (!watchedVideos.has(messageId)) {
      return messageId;
    }
  }
  
  return null;
}

async function forwardNextVideo(ctx, userId) {
  const nextVideoId = await getNextUnwatchedVideo(userId);
  
  if (!nextVideoId) {
    await ctx.reply('📭 No more videos available. You\'ve watched everything!');
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
    console.log(`Forwarded video ${nextVideoId} to user ${userId}`);
  } catch (error) {
    console.error('Error forwarding video:', error);
    await ctx.reply('❌ Error forwarding video. Please try again later.');
  }
}

bot.start(async (ctx) => {
  console.log('Received /start from user:', ctx.from.id);
  const userId = ctx.from.id;
  
  const isMember = await checkUserMembership(ctx, userId);
  if (!isMember) {
    await showJoinPrompt(ctx);
    return;
  }
  
  await ctx.reply(
    '👋 Welcome to the Video Bot!\n\n' +
    'Use /newvideo to get your next unwatched video, or click the "Next Video" button under any forwarded video.\n\n' +
    'The bot tracks your watch history so you never see the same video twice!'
  );
});

bot.command('newvideo', async (ctx) => {
  console.log('Received /newvideo from user:', ctx.from.id);
  const userId = ctx.from.id;
  
  const isMember = await checkUserMembership(ctx, userId);
  if (!isMember) {
    await showJoinPrompt(ctx);
    return;
  }
  
  await forwardNextVideo(ctx, userId);
});

bot.action('next_video', async (ctx) => {
  console.log('Received next_video action from user:', ctx.from.id);
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
  console.log('Received retry_join action from user:', ctx.from.id);
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
    console.log('Received channel post from:', ctx.channelPost.chat.id);
    if (ctx.channelPost.chat.id.toString() === SOURCE_CHANNEL_ID.toString()) {
      if (ctx.channelPost.video) {
        const messageId = ctx.channelPost.message_id;
        const date = ctx.channelPost.date;
        await addChannelVideo(messageId, date);
        console.log(`New video detected and added: ${messageId}`);
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
    status: 'Bot is running',
    videos: channelVideos.length,
    storage: db ? 'MongoDB' : 'In-Memory'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    videos: channelVideos.length
  });
});

async function main() {
  try {
    console.log('Initializing bot...');
    await initMongo();
    
    console.log('Starting bot in polling mode...');
    await bot.launch();
    console.log('Bot launched successfully in polling mode');
    
    app.listen(PORT, () => {
      console.log(`Health check server running on port ${PORT}`);
    });
    
    process.once('SIGINT', () => {
      console.log('SIGINT received, stopping bot...');
      bot.stop('SIGINT');
    });
    
    process.once('SIGTERM', () => {
      console.log('SIGTERM received, stopping bot...');
      bot.stop('SIGTERM');
    });
    
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();
