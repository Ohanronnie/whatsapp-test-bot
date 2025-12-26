import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';

const execPromise = promisify(exec);

export interface BackgroundRemovalResult {
    success: boolean;
    filePath?: string;
    error?: string;
}

/**
 * Remove background from an image using rembg
 * Requires: pip install rembg[cli]
 */
export async function removeBackground(inputPath: string): Promise<BackgroundRemovalResult> {
    const outputPath = path.join(tmpdir(), `nobg_${Date.now()}.png`);
    
    try {
        // Check if rembg is installed
        try {
            await execPromise('rembg --version', { timeout: 5000 });
        } catch {
            return { 
                success: false, 
                error: 'rembg is not installed. Please install it: `pip install rembg[cli]`' 
            };
        }
        
        console.log('Removing background from image...');
        
        // Run rembg
        await execPromise(`rembg i "${inputPath}" "${outputPath}"`, { 
            timeout: 120000 // 2 minute timeout for large images
        });
        
        // Verify output exists
        try {
            await fs.access(outputPath);
        } catch {
            return { success: false, error: 'Background removal completed but output not found' };
        }
        
        console.log('Background removed successfully');
        
        return {
            success: true,
            filePath: outputPath
        };
        
    } catch (error: any) {
        console.error('Background removal error:', error);
        
        if (error.message?.includes('CUDA') || error.message?.includes('GPU')) {
            // Try with CPU fallback
            try {
                await execPromise(`rembg i --force-cpu "${inputPath}" "${outputPath}"`, { 
                    timeout: 180000 
                });
                return { success: true, filePath: outputPath };
            } catch (cpuError: any) {
                return { success: false, error: cpuError.message || 'Failed with CPU fallback' };
            }
        }
        
        return { success: false, error: error.message || 'Failed to remove background' };
    }
}

/**
 * Clean up temporary file
 */
export async function cleanupFile(filePath: string): Promise<void> {
    try {
        await fs.unlink(filePath);
    } catch (e) {
        // Ignore cleanup errors
    }
}
