process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import axios from 'axios';
import https from 'https';
import { searchNkiri, getDownloadLinks } from './nkiri';
import type { MovieSearchResult, DownloadLink } from './nkiri';
import { extractMediaUrl, downloadMedia, cleanupFile as cleanupMediaFile, getPlatformEmoji } from './media-downloader';
import { removeBackground, cleanupFile as cleanupBgFile } from './background-remover';

const execPromise = promisify(exec);

interface Session {
    state: 'SEARCH_RESULTS' | 'EPISODE_SELECTION' | 'DOWNLOAD_METHOD_SELECTION';
    lastResults?: MovieSearchResult[];
    lastLinks?: DownloadLink[];
    selectedMovie?: MovieSearchResult;
    selectedLink?: DownloadLink;
    timestamp: number;
}

const sessions: Record<string, Session> = {};

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
    }
});

client.on('qr', (qr) => {
    console.log('Scan the QR code below to log in:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

async function sendPeriodicUpdates(chatId: string, messages: string[]) {
    for (const msg of messages) {
        await client.sendMessage(chatId, `⏳ ${msg}`);
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
}

async function downloadAndSend(chatId: string, item: DownloadLink) {
    const tempFile = path.join(tmpdir(), `movie_${Date.now()}.mp4`);
    
    try {
        await client.sendMessage(chatId, `🚀 Starting download: *${item.label}*\nPlease wait...`);
        
        const response = await axios({
            method: 'get',
            url: item.url,
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        const totalBytes = parseInt(response.headers['content-length'] || '0');
        let downloadedBytes = 0;
        let lastLoggedProgress = -1;

        const writer = createWriteStream(tempFile);
        
        response.data.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0) {
                const progress = Math.floor((downloadedBytes / totalBytes) * 100);
                if (progress % 10 === 0 && progress !== lastLoggedProgress) {
                    console.log(`Download progress for ${item.label}: ${progress}% (${(downloadedBytes / 1024 / 1024).toFixed(2)}MB / ${(totalBytes / 1024 / 1024).toFixed(2)}MB)`);
                    
                    // Send update to user every 25%
                    if (progress % 25 === 0 && progress > 0 && progress < 100) {
                        client.sendMessage(chatId, `⏳ Download progress: ${progress}%...`);
                    }
                    
                    lastLoggedProgress = progress;
                }
            } else {
                // If no content-length, just log the MBs in terminal
                if (Math.floor(downloadedBytes / 1024 / 1024) % 10 === 0 && Math.floor(downloadedBytes / 1024 / 1024) !== lastLoggedProgress) {
                   console.log(`Downloaded: ${(downloadedBytes / 1024 / 1024).toFixed(2)}MB`);
                   lastLoggedProgress = Math.floor(downloadedBytes / 1024 / 1024);
                }
            }
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`Download complete: ${item.label}`);
        await client.sendMessage(chatId, `✅ Download complete! Sending to you now...`);
        
        // Extract filename from URL (last part after /)
        let fileName: string = item.url.split('/').pop() || `${item.label}.mp4`;
        // Remove query params
        fileName = fileName.split('?')[0] || fileName;
        // Ensure it has extension
        if (!fileName.endsWith('.mp4') && !fileName.endsWith('.mkv')) {
            fileName = `${fileName}.mp4`;
        }
        
        // Rename temp file to proper filename
        const finalFile = path.join(tmpdir(), fileName);
        await fs.rename(tempFile, finalFile);
        
        const media = MessageMedia.fromFilePath(finalFile);
        await client.sendMessage(chatId, media, { 
            sendMediaAsDocument: true, 
            caption: `Here is your movie: ${item.label}`
        });
        
        // Cleanup the final file
        try { await fs.unlink(finalFile); } catch (e) {}

    } catch (error) {
        console.error('Download Error:', error);
        await client.sendMessage(chatId, "❌ Failed to download or send the file. The file might be too large or the link expired.");
    } finally {
        try { await fs.unlink(tempFile); } catch (e) {}
    }
}

client.on('message', async (msg) => {
    const chatId = msg.from;
    const text = msg.body.trim().toLowerCase();

    // 1. Handle GIF/Image to Sticker and Background Removal
    if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        const isGif = media.mimetype === 'image/gif' || (media.mimetype === 'video/mp4' && msg.isGif);
        const isImage = media.mimetype?.startsWith('image/') && !isGif;
        
        // Check for sticker command
        const wantsSticker = text === 'sticker' || text === 's';
        
        // Check for background removal command
        const wantsBgRemove = text === 'removebg' || text === 'rmbg' || text === 'nobg';
        
        // Auto-convert GIF or image with "sticker" caption
        if (isGif || (isImage && wantsSticker)) {
            await client.sendMessage(chatId, "🎨 Converting to sticker...");
            const tempInput = path.join(tmpdir(), `input_${Date.now()}.${isGif ? 'mp4' : 'png'}`);
            const tempOutput = path.join(tmpdir(), `output_${Date.now()}.webp`);
            try {
                await fs.writeFile(tempInput, media.data, 'base64');
                
                if (isGif) {
                    await execPromise(`ffmpeg -i "${tempInput}" -vcodec libwebp -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -lossless 0 -compression_level 6 -q:v 50 -loop 0 -preset default -an -vsync 0 "${tempOutput}"`);
                } else {
                    await execPromise(`ffmpeg -i "${tempInput}" -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -c:v libwebp -lossless 0 -compression_level 6 -q:v 80 "${tempOutput}"`);
                }
                
                const outputData = await fs.readFile(tempOutput, { encoding: 'base64' });
                const stickerMedia = new MessageMedia('image/webp', outputData, 'sticker.webp');
                await client.sendMessage(chatId, stickerMedia, { sendMediaAsSticker: true, stickerName: "Bot", stickerAuthor: "Ronnie" });
            } catch (e) {
                console.error('Sticker conversion error:', e);
                msg.reply("❌ Error converting to sticker.");
            } finally {
                try { await fs.unlink(tempInput); await fs.unlink(tempOutput); } catch (e) {}
            }
            return;
        }
        
        // Background removal
        if (isImage && wantsBgRemove) {
            await client.sendMessage(chatId, "🔄 Removing background...\nThis may take a moment.");
            const tempInput = path.join(tmpdir(), `bg_input_${Date.now()}.png`);
            
            try {
                await fs.writeFile(tempInput, media.data, 'base64');
                
                const result = await removeBackground(tempInput);
                
                if (result.success && result.filePath) {
                    const outputData = await fs.readFile(result.filePath, { encoding: 'base64' });
                    const outputMedia = new MessageMedia('image/png', outputData, 'no_background.png');
                    await client.sendMessage(chatId, outputMedia, { caption: "✅ Background removed!" });
                    await cleanupBgFile(result.filePath);
                } else {
                    await client.sendMessage(chatId, `❌ ${result.error || 'Failed to remove background'}`);
                }
            } catch (e: any) {
                console.error('Background removal error:', e);
                await client.sendMessage(chatId, `❌ Error: ${e.message}`);
            } finally {
                try { await fs.unlink(tempInput); } catch (e) {}
            }
            return;
        }
    }

    // 2. Movie Search
    if (text.startsWith('search ')) {
        const query = text.replace('search ', '').trim();
        if (!query) return msg.reply("Usage: search <movie name>");

        msg.reply(`🔍 Searching for "${query}" on Thenkiri...`);
        const results = await searchNkiri(query);

        if (results.length === 0) return msg.reply("❌ No results found.");

        sessions[chatId] = {
            state: 'SEARCH_RESULTS',
            lastResults: results.slice(0, 10),
            timestamp: Date.now()
        };

        let menu = "🍿 *Results:*\n\n";
        sessions[chatId].lastResults!.forEach((r, i) => menu += `${i + 1}. ${r.title}\n`);
        menu += "\nReply with the *number* to see episodes/links.";
        client.sendMessage(chatId, menu);
        return;
    }

    // 3. Selection Handling
    const selection = parseInt(text);
    if (!isNaN(selection) && sessions[chatId]) {
        const session = sessions[chatId];
        
        // Handle Movie Selection -> Show Episodes
        if (session.state === 'SEARCH_RESULTS') {
            const movie = session.lastResults![selection - 1];
            if (!movie) return msg.reply("Invalid selection.");

            client.sendMessage(chatId, `🎞️ Opening *${movie.title}*...`);
            
            /*sendPeriodicUpdates(chatId, [
                "Bypassing safe-links...",
                "Searching for direct streams...",
                "Extracting download keys..."
            ]);*/ // Removed await to run in background

            const links = await getDownloadLinks(movie.url);
            if (links.length === 0) return msg.reply("❌ No download links found.");

            session.state = 'EPISODE_SELECTION';
            session.lastLinks = links;
            session.selectedMovie = movie;
            session.timestamp = Date.now();

            let menu = `📥 *Results for ${movie.title}:*\n\n`;
            links.forEach((l: DownloadLink, i: number) => {
                let cleanLabel = l.label;
                
                // Try to find Season and Episode
                // This regex looks for S01, E01, Season 1, Episode 1, etc.
                const sMatch = cleanLabel.match(/[Ss](?:eason)?\s*(\d+)/i);
                const epMatch = cleanLabel.match(/[Ee](?:pisode)?\s*(\d+)/i);
                
                if (epMatch && epMatch[1]) {
                    const episode = parseInt(epMatch[1]);
                    const season = (sMatch && sMatch[1]) ? parseInt(sMatch[1]) : '';
                    
                    // Format: "Movie Title [S1] Episode 1"
                    const displayTitle = movie.title.replace(/\s*[Ss](\d+).*/i, '').trim(); // Remove S1 from title if already there
                    cleanLabel = `${displayTitle} ${season ? 'S' + season : ''} Episode ${i + 1}`.replace(/\s+/g, ' ');
                } else {
                    // Fallback cleanup if no Episode number found
                    cleanLabel = cleanLabel.replace(/download/gi, '')
                                           .replace(/\.(mkv|mp4|html|nkiri|com)/gi, ' ')
                                           .replace(/[._-]/g, ' ')
                                           .trim();
                    if (!cleanLabel.toLowerCase().includes(movie.title.toLowerCase())) {
                        cleanLabel = `${movie.title} - ${cleanLabel} ${i+1}`;
                    }
                }

                menu += `${i + 1}. ${cleanLabel}\n`;
            });
            menu += "\nReply with the *number* to *DOWNLOAD & SEND* the file.";
            client.sendMessage(chatId, menu);
            return;
        }

        // Handle Episode Selection -> Ask for Method
        if (session.state === 'EPISODE_SELECTION') {
            const link = session.lastLinks![selection - 1];
            if (!link) return msg.reply("Invalid selection.");

            session.state = 'DOWNLOAD_METHOD_SELECTION';
            session.selectedLink = link;
            session.timestamp = Date.now();

            let choiceMenu = `❓ *How would you like to receive "${link.label}"?*\n\n`;
            choiceMenu += "1. *Get Direct Link* (Fastest, no waiting)\n";
            choiceMenu += "2. *Send as File* (⚠️ Risky & Not reliable)\n\n";
            choiceMenu += "Reply with *1* or *2*.";
            
            client.sendMessage(chatId, choiceMenu);
            return;
        }

        // Handle Download Method Selection
        if (session.state === 'DOWNLOAD_METHOD_SELECTION') {
            const link = session.selectedLink!;
            
            if (selection === 1) {
                // Option 1: Just send the link alone
                await client.sendMessage(chatId, link.url);
                delete sessions[chatId];
            } else if (selection === 2) {
                // Option 2: Download and send
                delete sessions[chatId];
                await downloadAndSend(chatId, link);
            } else {
                msg.reply("Please reply with *1* for the link or *2* for the file.");
            }
            return;
        }
    }

    // 4. Media Download (YouTube, Instagram, TikTok, Twitter)
    const mediaMatch = extractMediaUrl(msg.body);
    const wantsAudio = text.includes('audio') || text.includes('mp3') || text.includes('music');
    
    if (mediaMatch) {
        const emoji = getPlatformEmoji(mediaMatch.platform);
        const platformName = mediaMatch.platform.charAt(0).toUpperCase() + mediaMatch.platform.slice(1);
        
        await client.sendMessage(chatId, `${emoji} Downloading from ${platformName}...${wantsAudio ? ' (audio only)' : ''}\nThis may take a moment.`);
        
        const result = await downloadMedia(mediaMatch.url, wantsAudio);
        
        if (result.success && result.filePath) {
            try {
                const sizeMB = (await fs.stat(result.filePath)).size / (1024 * 1024);
                
                await client.sendMessage(chatId, `✅ Downloaded: *${result.title}*\n📁 Size: ${sizeMB.toFixed(2)}MB\nSending now...`);
                
                const media = MessageMedia.fromFilePath(result.filePath);
                await client.sendMessage(chatId, media, {
                    sendMediaAsDocument: result.isAudio,
                    caption: `${emoji} ${result.title}`
                });
                
            } catch (sendError: any) {
                console.error('Error sending media:', sendError);
                try {
                    const media = MessageMedia.fromFilePath(result.filePath);
                    await client.sendMessage(chatId, media, {
                        sendMediaAsDocument: true,
                        caption: `${emoji} ${result.title}`
                    });
                } catch (docError) {
                    await client.sendMessage(chatId, `❌ Failed to send: ${sendError.message}`);
                }
            } finally {
                await cleanupMediaFile(result.filePath);
            }
        } else {
            await client.sendMessage(chatId, `❌ ${result.error || 'Failed to download'}`);
        }
        return;
    }

    // Default Help
    if (!msg.hasMedia && !text.startsWith('search ')) {
        const helpMessage = `👋 *WhatsApp Bot Menu*

📥 *Media Downloads*
• Send a YouTube/Instagram/TikTok/Twitter link
• Add "audio" or "mp3" for audio-only (YouTube)

🎨 *Stickers*
• Send a GIF → auto-converts to sticker
• Send image with caption "sticker" or "s"

🖼️ *Image Tools*
• Send image with caption "removebg" or "nobg"

🎬 *Movies*
• Type \`search <movie name>\``;
        
        client.sendMessage(chatId, helpMessage);
    }
});

client.initialize();