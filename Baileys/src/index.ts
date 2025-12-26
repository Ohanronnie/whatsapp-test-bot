process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    downloadMediaMessage,
    fetchLatestWaWebVersion,
    WASocket,
    proto,
    getContentType,
    AnyMessageContent
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import axios from 'axios';
import https from 'https';
import { searchNkiri, getDownloadLinks } from './nkiri.js';
import type { MovieSearchResult, DownloadLink } from './nkiri.js';
import { extractMediaUrl, downloadMedia, cleanupFile as cleanupMediaFile, getPlatformEmoji, Platform } from './media-downloader.js';
import { removeBackground, cleanupFile as cleanupBgFile } from './background-remover.js';

const execPromise = promisify(exec);

// Pino logger with minimal output
const logger = pino({ level: 'silent' });

interface Session {
    state: 'SEARCH_RESULTS' | 'EPISODE_SELECTION' | 'DOWNLOAD_METHOD_SELECTION';
    lastResults?: MovieSearchResult[];
    lastLinks?: DownloadLink[];
    selectedMovie?: MovieSearchResult;
    selectedLink?: DownloadLink;
    timestamp: number;
}

const sessions: Record<string, Session> = {};

let sock: WASocket;
let isConnected = false;

// Wait for connection with timeout
async function waitForConnection(timeoutMs: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    while (!isConnected && Date.now() - startTime < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return isConnected;
}

// Send message with retry logic
async function sendMessage(chatId: string, content: AnyMessageContent, retries: number = 3): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
        if (!isConnected) {
            console.log(`Not connected, waiting... (attempt ${i + 1}/${retries})`);
            const connected = await waitForConnection(5000);
            if (!connected) {
                console.log('Still not connected, retrying...');
                continue;
            }
        }
        
        try {
            await sock.sendMessage(chatId, content);
            return true;
        } catch (error: any) {
            console.error(`Send failed (attempt ${i + 1}/${retries}):`, error.message);
            if (i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    console.error('Failed to send message after all retries');
    return false;
}

async function sendTextMessage(chatId: string, text: string): Promise<boolean> {
    return sendMessage(chatId, { text });
}

async function downloadAndSend(chatId: string, item: DownloadLink) {
    const tempFile = path.join(tmpdir(), `movie_${Date.now()}.mp4`);
    
    try {
        await sendTextMessage(chatId, `🚀 Starting download: *${item.label}*\nPlease wait...`);
        
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
        
        response.data.on('data', async (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0) {
                const progress = Math.floor((downloadedBytes / totalBytes) * 100);
                if (progress % 10 === 0 && progress !== lastLoggedProgress) {
                    console.log(`Download progress for ${item.label}: ${progress}% (${(downloadedBytes / 1024 / 1024).toFixed(2)}MB / ${(totalBytes / 1024 / 1024).toFixed(2)}MB)`);
                    
                    // Send update to user every 25%
                    if (progress % 25 === 0 && progress > 0 && progress < 100) {
                        sendTextMessage(chatId, `⏳ Download progress: ${progress}%...`);
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

        await new Promise<void>((resolve, reject) => {
            writer.on('finish', () => resolve());
            writer.on('error', reject);
        });

        console.log(`Download complete: ${item.label}`);
        await sendTextMessage(chatId, `✅ Download complete! Sending to you now...`);
        
        // Extract filename from URL (last part after /)
        let fileName = item.url.split('/').pop() || `${item.label}.mp4`;
        // Remove query params
        fileName = fileName.split('?')[0];
        // Ensure it has extension
        if (!fileName.endsWith('.mp4') && !fileName.endsWith('.mkv')) {
            fileName = `${fileName}.mp4`;
        }
        
        // Read file and send as document
        const fileBuffer = await fs.readFile(tempFile);
        await sendMessage(chatId, {
            document: fileBuffer,
            mimetype: 'video/mp4',
            fileName: fileName,
            caption: `Here is your movie: ${item.label}`
        });

    } catch (error) {
        console.error('Download Error:', error);
        await sendTextMessage(chatId, "❌ Failed to download or send the file. The file might be too large or the link expired.");
    } finally {
        try { await fs.unlink(tempFile); } catch (e) {}
    }
}

async function handleMessage(chatId: string, message: proto.IWebMessageInfo) {
    const messageContent = message.message;
    if (!messageContent) return;

    const contentType = getContentType(messageContent);
    
    // Get text from various message types
    let text = '';
    if (contentType === 'conversation') {
        text = messageContent.conversation || '';
    } else if (contentType === 'extendedTextMessage') {
        text = messageContent.extendedTextMessage?.text || '';
    } else if (contentType === 'imageMessage') {
        text = messageContent.imageMessage?.caption || '';
    } else if (contentType === 'videoMessage') {
        text = messageContent.videoMessage?.caption || '';
    }
    
    text = text.trim().toLowerCase();

    // 1. Handle GIF/Image to Sticker
    const isGif = contentType === 'videoMessage' && messageContent.videoMessage?.gifPlayback;
    const isImage = contentType === 'imageMessage';
    
    // Check for "sticker" command with image
    const wantsSticker = text === 'sticker' || text === 's';
    
    if (isGif || (isImage && wantsSticker)) {
        await sendTextMessage(chatId, "🎨 Converting to sticker...");
        
        const tempInput = path.join(tmpdir(), `input_${Date.now()}.${isGif ? 'mp4' : 'png'}`);
        const tempOutput = path.join(tmpdir(), `output_${Date.now()}.webp`);
        
        try {
            // Download media using Baileys
            const buffer = await downloadMediaMessage(
                message,
                'buffer',
                {},
                { 
                    logger,
                    reuploadRequest: sock.updateMediaMessage 
                }
            );
            
            await fs.writeFile(tempInput, buffer as Buffer);
            
            // Convert to WebP sticker (different command for static vs animated)
            if (isGif) {
                await execPromise(`ffmpeg -i "${tempInput}" -vcodec libwebp -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -lossless 0 -compression_level 6 -q:v 50 -loop 0 -preset default -an -vsync 0 "${tempOutput}"`);
            } else {
                // Static image to sticker
                await execPromise(`ffmpeg -i "${tempInput}" -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000" -c:v libwebp -lossless 0 -compression_level 6 -q:v 80 "${tempOutput}"`);
            }
            
            const stickerBuffer = await fs.readFile(tempOutput);
            
            await sendMessage(chatId, {
                sticker: stickerBuffer
            });
            
        } catch (e) {
            console.error('Sticker conversion error:', e);
            await sendTextMessage(chatId, "❌ Error converting to sticker.");
        } finally {
            try { await fs.unlink(tempInput); await fs.unlink(tempOutput); } catch (e) {}
        }
        return;
    }
    
    // 1b. Handle Background Removal from image
    const wantsBgRemove = text === 'removebg' || text === 'rmbg' || text === 'nobg';
    
    if (isImage && wantsBgRemove) {
        await sendTextMessage(chatId, "🔄 Removing background...\nThis may take a moment.");
        
        const tempInput = path.join(tmpdir(), `bg_input_${Date.now()}.png`);
        
        try {
            const buffer = await downloadMediaMessage(
                message,
                'buffer',
                {},
                { 
                    logger,
                    reuploadRequest: sock.updateMediaMessage 
                }
            );
            
            await fs.writeFile(tempInput, buffer as Buffer);
            
            const result = await removeBackground(tempInput);
            
            if (result.success && result.filePath) {
                const outputBuffer = await fs.readFile(result.filePath);
                
                await sendMessage(chatId, {
                    image: outputBuffer,
                    caption: "✅ Background removed!"
                });
                
                await cleanupBgFile(result.filePath);
            } else {
                await sendTextMessage(chatId, `❌ ${result.error || 'Failed to remove background'}`);
            }
            
        } catch (e: any) {
            console.error('Background removal error:', e);
            await sendTextMessage(chatId, `❌ Error: ${e.message}`);
        } finally {
            try { await fs.unlink(tempInput); } catch (e) {}
        }
        return;
    }

    // 2. Movie Search
    if (text.startsWith('search ')) {
        const query = text.replace('search ', '').trim();
        if (!query) {
            await sendTextMessage(chatId, "Usage: search <movie name>");
            return;
        }

        await sendTextMessage(chatId, `🔍 Searching for "${query}" on Thenkiri...`);
        const results = await searchNkiri(query);

        if (results.length === 0) {
            await sendTextMessage(chatId, "❌ No results found.");
            return;
        }

        sessions[chatId] = {
            state: 'SEARCH_RESULTS',
            lastResults: results.slice(0, 10),
            timestamp: Date.now()
        };

        let menu = "🍿 *Results:*\n\n";
        sessions[chatId].lastResults!.forEach((r, i) => menu += `${i + 1}. ${r.title}\n`);
        menu += "\nReply with the *number* to see episodes/links.";
        await sendTextMessage(chatId, menu);
        return;
    }

    // 3. Selection Handling
    const selection = parseInt(text);
    if (!isNaN(selection) && sessions[chatId]) {
        const session = sessions[chatId];
        
        // Handle Movie Selection -> Show Episodes
        if (session.state === 'SEARCH_RESULTS') {
            const movie = session.lastResults![selection - 1];
            if (!movie) {
                await sendTextMessage(chatId, "Invalid selection.");
                return;
            }

            await sendTextMessage(chatId, `🎞️ Opening *${movie.title}*...`);

            const links = await getDownloadLinks(movie.url);
            if (links.length === 0) {
                await sendTextMessage(chatId, "❌ No download links found.");
                return;
            }

            session.state = 'EPISODE_SELECTION';
            session.lastLinks = links;
            session.selectedMovie = movie;
            session.timestamp = Date.now();

            let menu = `📥 *Results for ${movie.title}:*\n\n`;
            links.forEach((l: DownloadLink, i: number) => {
                let cleanLabel = l.label;
                
                // Try to find Season and Episode
                const sMatch = cleanLabel.match(/[Ss](?:eason)?\s*(\d+)/i);
                const epMatch = cleanLabel.match(/[Ee](?:pisode)?\s*(\d+)/i);
                
                if (epMatch && epMatch[1]) {
                    const season = (sMatch && sMatch[1]) ? parseInt(sMatch[1]) : '';
                    const displayTitle = movie.title.replace(/\s*[Ss](\d+).*/i, '').trim();
                    cleanLabel = `${displayTitle} ${season ? 'S' + season : ''} Episode ${i + 1}`.replace(/\s+/g, ' ');
                } else {
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
            await sendTextMessage(chatId, menu);
            return;
        }

        // Handle Episode Selection -> Ask for Method
        if (session.state === 'EPISODE_SELECTION') {
            const link = session.lastLinks![selection - 1];
            if (!link) {
                await sendTextMessage(chatId, "Invalid selection.");
                return;
            }

            session.state = 'DOWNLOAD_METHOD_SELECTION';
            session.selectedLink = link;
            session.timestamp = Date.now();

            let choiceMenu = `❓ *How would you like to receive "${link.label}"?*\n\n`;
            choiceMenu += "1. *Get Direct Link* (Fastest, no waiting)\n";
            choiceMenu += "2. *Send as File* (⚠️ Risky & Not reliable)\n\n";
            choiceMenu += "Reply with *1* or *2*.";
            
            await sendTextMessage(chatId, choiceMenu);
            return;
        }

        // Handle Download Method Selection
        if (session.state === 'DOWNLOAD_METHOD_SELECTION') {
            const link = session.selectedLink!;
            
            if (selection === 1) {
                // Option 1: Just send the link alone
                await sendTextMessage(chatId, link.url);
                delete sessions[chatId];
            } else if (selection === 2) {
                // Option 2: Download and send
                delete sessions[chatId];
                await downloadAndSend(chatId, link);
            } else {
                await sendTextMessage(chatId, "Please reply with *1* for the link or *2* for the file.");
            }
            return;
        }
    }

    // 4. Media Download (YouTube, Instagram, TikTok, Twitter)
    // Check original unmodified text for URLs (text was lowercased)
    const originalText = messageContent.conversation || 
                         messageContent.extendedTextMessage?.text || '';
    const mediaMatch = extractMediaUrl(originalText);
    
    // Check for audio-only request (for YouTube music)
    const wantsAudio = text.includes('audio') || text.includes('mp3') || text.includes('music');
    
    if (mediaMatch) {
        const emoji = getPlatformEmoji(mediaMatch.platform);
        const platformName = mediaMatch.platform.charAt(0).toUpperCase() + mediaMatch.platform.slice(1);
        
        await sendTextMessage(chatId, `${emoji} Downloading from ${platformName}...${wantsAudio ? ' (audio only)' : ''}\nThis may take a moment.`);
        
        const result = await downloadMedia(mediaMatch.url, wantsAudio);
        
        if (result.success && result.filePath) {
            try {
                const mediaBuffer = await fs.readFile(result.filePath);
                const sizeMB = mediaBuffer.length / (1024 * 1024);
                
                await sendTextMessage(chatId, `✅ Downloaded: *${result.title}*\n📁 Size: ${sizeMB.toFixed(2)}MB\nSending now...`);
                
                if (result.isAudio) {
                    await sendMessage(chatId, {
                        audio: mediaBuffer,
                        mimetype: 'audio/mp3',
                        ptt: false
                    });
                } else {
                    await sendMessage(chatId, {
                        video: mediaBuffer,
                        caption: `${emoji} ${result.title}`,
                        mimetype: 'video/mp4'
                    });
                }
                
            } catch (sendError: any) {
                console.error('Error sending media:', sendError);
                // Try sending as document if direct send fails
                try {
                    const mediaBuffer = await fs.readFile(result.filePath);
                    const ext = result.isAudio ? 'mp3' : 'mp4';
                    await sendMessage(chatId, {
                        document: mediaBuffer,
                        mimetype: result.isAudio ? 'audio/mp3' : 'video/mp4',
                        fileName: `${result.title || 'download'}.${ext}`,
                        caption: `${emoji} ${result.title}`
                    });
                } catch (docError) {
                    await sendTextMessage(chatId, `❌ Failed to send: ${sendError.message}`);
                }
            } finally {
                await cleanupMediaFile(result.filePath);
            }
        } else {
            await sendTextMessage(chatId, `❌ ${result.error || 'Failed to download'}`);
        }
        return;
    }

    // Default Help
    const hasMedia = isGif || isImage;
    if (!hasMedia && !text.startsWith('search ')) {
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
        
        await sendTextMessage(chatId, helpMessage);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    // Fetch the latest WhatsApp Web version to avoid 405 errors
    // Use a timeout with fallback to a known working version
    let version: [number, number, number];
    try {
        const fetchWithTimeout = Promise.race([
            fetchLatestWaWebVersion({}),
            new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error('Timeout')), 10000)
            )
        ]);
        const result = await fetchWithTimeout;
        version = result.version;
        console.log(`Using WA v${version.join('.')}, isLatest: ${result.isLatest}`);
    } catch (e) {
        // Fallback to a known working version
        version = [2, 3000, 1015901307];
        console.log(`Failed to fetch version, using fallback: v${version.join('.')}`);
    }
    
    sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false, // We'll handle QR ourselves
        // Use the fetched version
        version,
        // Use a more standard browser fingerprint
        browser: ['Ubuntu', 'Chrome', '124.0.6367.60'],
        // Mark as online when connected
        markOnlineOnConnect: true,
        // Sync full history on first connect (optional, can be set to false)
        syncFullHistory: false,
        // Connection timeout
        connectTimeoutMs: 60000,
        // Keep alive interval
        keepAliveIntervalMs: 30000,
        // Retry on network failures
        retryRequestDelayMs: 250,
        // Default query timeout
        defaultQueryTimeoutMs: undefined,
    });

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('Scan the QR code below to log in:');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            isConnected = false;
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Connection closed. Status: ${statusCode}, Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // Use longer delay for rate limiting issues (440, 515)
                const delay = [440, 515, 405].includes(statusCode || 0) ? 10000 : 3000;
                console.log(`Waiting ${delay/1000}s before reconnecting...`);
                setTimeout(() => {
                    connectToWhatsApp();
                }, delay);
            } else {
                console.log('Logged out. Please delete auth_info_baileys folder and restart.');
            }
        } else if (connection === 'open') {
            isConnected = true;
            console.log('✅ Client is ready!');
        }
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        for (const message of messages) {
            // Skip if message is from self or is a status broadcast
            if (message.key.fromMe) continue;
            if (message.key.remoteJid === 'status@broadcast') continue;
            
            const chatId = message.key.remoteJid;
            if (!chatId) continue;
            
            try {
                await handleMessage(chatId, message);
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }
    });
}

// Start the bot
console.log('🚀 Starting WhatsApp Bot with Baileys...');
connectToWhatsApp();
