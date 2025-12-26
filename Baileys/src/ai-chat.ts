import axios from 'axios';

export interface AIResponse {
    success: boolean;
    message?: string;
    error?: string;
}

// Store conversation history per chat
const conversationHistory: Record<string, Array<{ role: string; content: string }>> = {};

// Get API key from environment
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

/**
 * Chat with AI using Google Gemini (free tier available)
 */
export async function chatWithGemini(chatId: string, userMessage: string): Promise<AIResponse> {
    if (!GEMINI_API_KEY) {
        return { 
            success: false, 
            error: 'Please set GEMINI_API_KEY environment variable. Get one free at https://aistudio.google.com/apikey' 
        };
    }
    
    try {
        // Initialize or get conversation history
        if (!conversationHistory[chatId]) {
            conversationHistory[chatId] = [];
        }
        
        // Add user message to history
        conversationHistory[chatId].push({ role: 'user', content: userMessage });
        
        // Keep only last 10 messages to avoid token limits
        if (conversationHistory[chatId].length > 10) {
            conversationHistory[chatId] = conversationHistory[chatId].slice(-10);
        }
        
        // Build contents for Gemini API
        const contents = conversationHistory[chatId].map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        }));
        
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                contents,
                generationConfig: {
                    temperature: 0.7,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 1024,
                },
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
                ]
            },
            { timeout: 30000 }
        );
        
        const aiMessage = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!aiMessage) {
            return { success: false, error: 'No response from AI' };
        }
        
        // Add AI response to history
        conversationHistory[chatId].push({ role: 'assistant', content: aiMessage });
        
        return { success: true, message: aiMessage };
        
    } catch (error: any) {
        console.error('Gemini API error:', error.response?.data || error.message);
        
        if (error.response?.status === 429) {
            return { success: false, error: 'Rate limit exceeded. Please wait a moment.' };
        }
        
        if (error.response?.status === 400) {
            return { success: false, error: 'Invalid request. Try a different message.' };
        }
        
        return { success: false, error: error.message || 'Failed to get AI response' };
    }
}

/**
 * Chat with AI using OpenAI (GPT)
 */
export async function chatWithOpenAI(chatId: string, userMessage: string): Promise<AIResponse> {
    if (!OPENAI_API_KEY) {
        return { 
            success: false, 
            error: 'Please set OPENAI_API_KEY environment variable.' 
        };
    }
    
    try {
        // Initialize or get conversation history
        if (!conversationHistory[chatId]) {
            conversationHistory[chatId] = [];
        }
        
        // Add user message to history
        conversationHistory[chatId].push({ role: 'user', content: userMessage });
        
        // Keep only last 10 messages
        if (conversationHistory[chatId].length > 10) {
            conversationHistory[chatId] = conversationHistory[chatId].slice(-10);
        }
        
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: 'You are a helpful WhatsApp bot assistant. Keep responses concise and friendly.' },
                    ...conversationHistory[chatId]
                ],
                max_tokens: 1024,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        
        const aiMessage = response.data?.choices?.[0]?.message?.content;
        
        if (!aiMessage) {
            return { success: false, error: 'No response from AI' };
        }
        
        // Add AI response to history
        conversationHistory[chatId].push({ role: 'assistant', content: aiMessage });
        
        return { success: true, message: aiMessage };
        
    } catch (error: any) {
        console.error('OpenAI API error:', error.response?.data || error.message);
        return { success: false, error: error.message || 'Failed to get AI response' };
    }
}

/**
 * Main chat function - tries Gemini first (free), falls back to OpenAI
 */
export async function chat(chatId: string, userMessage: string): Promise<AIResponse> {
    // Try Gemini first (free tier)
    if (GEMINI_API_KEY) {
        return chatWithGemini(chatId, userMessage);
    }
    
    // Fall back to OpenAI
    if (OPENAI_API_KEY) {
        return chatWithOpenAI(chatId, userMessage);
    }
    
    return {
        success: false,
        error: '🤖 AI Chat is not configured.\n\nTo enable AI chat, set one of these environment variables:\n• GEMINI_API_KEY (Free at https://aistudio.google.com/apikey)\n• OPENAI_API_KEY'
    };
}

/**
 * Clear conversation history for a chat
 */
export function clearHistory(chatId: string): void {
    delete conversationHistory[chatId];
}

/**
 * Check if AI is configured
 */
export function isAIConfigured(): boolean {
    return !!(GEMINI_API_KEY || OPENAI_API_KEY);
}
