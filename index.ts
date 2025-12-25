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

const execPromise = promisify(exec);

interface Session {
    state: 'SEARCH_RESULTS' | 'EPISODE_SELECTION';
    lastResults?: MovieSearchResult[];
    lastLinks?: DownloadLink[];
    selectedMovie?: MovieSearchResult;
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
        await client.sendMessage(chatId, `🚀 Starting download: *${item.label}*\nPlease wait, this might take a few minutes...`);
        
        const response = await axios({
            method: 'get',
            url: item.url,
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        const writer = createWriteStream(tempFile);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        await client.sendMessage(chatId, `✅ Download complete! Sending to you now...`);
        
        const media = MessageMedia.fromFilePath(tempFile);
        await client.sendMessage(chatId, media, { 
            sendMediaAsDocument: true, // Send as document to avoid compression and 16MB limit
            caption: `Here is your movie: ${item.label}`
        });

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

    // 1. Handle GIF to Sticker
    if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media.mimetype === 'image/gif' || (media.mimetype === 'video/mp4' && msg.isGif)) {
            client.sendMessage(chatId, "I'm coming boss 🫠");
            const tempInput = path.join(tmpdir(), `input_${Date.now()}.${media.mimetype.split('/')[1]}`);
            const tempOutput = path.join(tmpdir(), `output_${Date.now()}.webp`);
            try {
                await fs.writeFile(tempInput, media.data, 'base64');
                await execPromise(`ffmpeg -i "${tempInput}" -vcodec libwebp -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -lossless 0 -compression_level 6 -q:v 50 -loop 0 -preset default -an -vsync 0 "${tempOutput}"`);
                const outputData = await fs.readFile(tempOutput, { encoding: 'base64' });
                const stickerMedia = new MessageMedia('image/webp', outputData, 'sticker.webp');
                await client.sendMessage(chatId, stickerMedia, { sendMediaAsSticker: true, stickerName: "Bot", stickerAuthor: "Ronnie" });
            } catch (e) {
                msg.reply("Error converting sticker.");
            } finally {
                try { await fs.unlink(tempInput); await fs.unlink(tempOutput); } catch (e) {}
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
            
            sendPeriodicUpdates(chatId, [
                "Bypassing safe-links...",
                "Searching for direct streams...",
                "Extracting download keys..."
            ]); // Removed await to run in background

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
                        cleanLabel = `${movie.title} - ${cleanLabel}`;
                    }
                }

                menu += `${i + 1}. ${cleanLabel}\n`;
            });
            menu += "\nReply with the *number* to *DOWNLOAD & SEND* the file.";
            client.sendMessage(chatId, menu);
            return;
        }

        // Handle Episode Selection -> Download & Send
        if (session.state === 'EPISODE_SELECTION') {
            const link = session.lastLinks![selection - 1];
            if (!link) return msg.reply("Invalid selection.");

            // Clear session to prevent double downloads
            delete sessions[chatId];
            
            await downloadAndSend(chatId, link);
            return;
        }
    }

    // Default Help
    if (!msg.hasMedia && !text.startsWith('search ')) {
        client.sendMessage(chatId, "👋 *Menu*\n\n" +
            "1. Send a GIF to get a sticker.\n" +
            "2. Type `search <name>` to find movies.");
    }
});

client.initialize();