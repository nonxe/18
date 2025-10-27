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
    
    const videos = await videosCollection.find({}).sort({ messageId: -1 }).toArray();
    allVideos = videos.map(v => v.messageId);
    
    console.log('MongoDB connected. Videos loaded:', allVideos.length);
  } catch (error) {
    console.error('MongoDB failed, using in-memory:', error);
    db = null;
  }
}

async function saveVideo(messageId) {
  if (allVideos.includes(messageId)) {
    return;
  }
  
  allVideos.push(messageId);
  
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
    
    console.log(`Sent video ${videoMessageId} to user ${userId}`);
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
