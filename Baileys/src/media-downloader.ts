import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';

const execPromise = promisify(exec);

export interface MediaDownloadResult {
    success: boolean;
    filePath?: string;
    title?: string;
    duration?: number;
    isAudio?: boolean;
    error?: string;
}

export type Platform = 'youtube' | 'instagram' | 'tiktok' | 'twitter' | 'unknown';

/**
 * Detect which platform a URL belongs to
 */
export function detectPlatform(url: string): Platform {
    if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) return 'youtube';
    if (/^https?:\/\/(www\.)?(instagram\.com|instagr\.am)\//i.test(url)) return 'instagram';
    if (/^https?:\/\/(www\.)?(tiktok\.com|vm\.tiktok\.com)\//i.test(url)) return 'tiktok';
    if (/^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i.test(url)) return 'twitter';
    return 'unknown';
}

/**
 * Extract a supported URL from text
 */
export function extractMediaUrl(text: string): { url: string; platform: Platform } | null {
    const urlPatterns = [
        // YouTube
        /https?:\/\/(www\.)?(youtube\.com\/watch\?v=[\w-]+|youtu\.be\/[\w-]+)[^\s]*/i,
        // Instagram
        /https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+[^\s]*/i,
        // TikTok
        /https?:\/\/(www\.)?(tiktok\.com\/@[\w.]+\/video\/\d+|vm\.tiktok\.com\/[\w]+)[^\s]*/i,
        // Twitter/X
        /https?:\/\/(www\.)?(twitter\.com|x\.com)\/\w+\/status\/\d+[^\s]*/i,
    ];

    for (const pattern of urlPatterns) {
        const match = text.match(pattern);
        if (match) {
            const url = match[0];
            return { url, platform: detectPlatform(url) };
        }
    }
    return null;
}

/**
 * Download media from YouTube, Instagram, TikTok, or Twitter using yt-dlp
 */
export async function downloadMedia(url: string, audioOnly: boolean = false): Promise<MediaDownloadResult> {
    const outputDir = tmpdir();
    const timestamp = Date.now();
    const platform = detectPlatform(url);
    const prefix = platform === 'unknown' ? 'media' : platform;
    const outputTemplate = path.join(outputDir, `${prefix}_${timestamp}.%(ext)s`);
    
    try {
        // Get video info first
        const infoCmd = `yt-dlp --no-warnings --print title "${url}"`;
        let title = `${platform.charAt(0).toUpperCase() + platform.slice(1)} Video`;
        
        try {
            const { stdout } = await execPromise(infoCmd, { timeout: 30000 });
            title = stdout.trim().substring(0, 100) || title;
        } catch (e) {
            console.log('Could not get video title, using default');
        }
        
        // Build download command based on options
        let downloadCmd: string;
        
        if (audioOnly) {
            // Audio only (for YouTube music)
            downloadCmd = `yt-dlp --no-warnings -x --audio-format mp3 --audio-quality 0 -o "${outputTemplate}" "${url}"`;
        } else {
            // Video with reasonable quality (720p max to keep size manageable)
            downloadCmd = `yt-dlp --no-warnings -f "bestvideo[height<=720]+bestaudio/best[height<=720]/best" --merge-output-format mp4 -o "${outputTemplate}" "${url}"`;
        }
        
        console.log(`Downloading from ${platform}: ${url}`);
        await execPromise(downloadCmd, { timeout: 300000 }); // 5 minute timeout
        
        // Find the downloaded file
        const files = await fs.readdir(outputDir);
        const extensions = audioOnly ? ['.mp3', '.m4a', '.opus', '.webm'] : ['.mp4', '.webm', '.mkv'];
        const downloadedFile = files.find(f => 
            f.startsWith(`${prefix}_${timestamp}`) && 
            extensions.some(ext => f.endsWith(ext))
        );
        
        if (!downloadedFile) {
            return { success: false, error: 'Download completed but file not found' };
        }
        
        const filePath = path.join(outputDir, downloadedFile);
        
        // Check file size (WhatsApp limits)
        const stats = await fs.stat(filePath);
        const sizeMB = stats.size / (1024 * 1024);
        
        if (sizeMB > 64) {
            await fs.unlink(filePath);
            return { success: false, error: `File too large (${sizeMB.toFixed(1)}MB). Maximum is 64MB. Try audio-only for music.` };
        }
        
        console.log(`Downloaded: ${title} (${sizeMB.toFixed(2)}MB)`);
        
        return {
            success: true,
            filePath,
            title,
            isAudio: audioOnly
        };
        
    } catch (error: any) {
        console.error(`${platform} download error:`, error);
        
        // Handle common errors
        if (error.message?.includes('not found') || error.code === 'ENOENT') {
            return { success: false, error: 'yt-dlp is not installed. Please install it.' };
        }
        
        if (error.message?.includes('Private') || error.message?.includes('protected')) {
            return { success: false, error: 'This content is private or protected.' };
        }
        
        if (error.message?.includes('unavailable') || error.message?.includes('deleted')) {
            return { success: false, error: 'This content is unavailable or has been deleted.' };
        }
        
        if (error.message?.includes('age')) {
            return { success: false, error: 'This content is age-restricted.' };
        }
        
        if (error.message?.includes('copyright')) {
            return { success: false, error: 'This content is blocked due to copyright.' };
        }
        
        return { success: false, error: error.message?.substring(0, 200) || 'Failed to download' };
    }
}

/**
 * Clean up a downloaded file
 */
export async function cleanupFile(filePath: string): Promise<void> {
    try {
        await fs.unlink(filePath);
    } catch (e) {
        // Ignore cleanup errors
    }
}

/**
 * Get platform emoji
 */
export function getPlatformEmoji(platform: Platform): string {
    switch (platform) {
        case 'youtube': return '📺';
        case 'instagram': return '📸';
        case 'tiktok': return '🎵';
        case 'twitter': return '🐦';
        default: return '📥';
    }
}
