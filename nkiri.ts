import axios from 'axios';
import https from 'https';
import * as cheerio from 'cheerio';
import urlencode from 'urlencode';

// Globally disable SSL verification for this scraper since download servers often have misconfigured certs
const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

export interface MovieSearchResult {
    title: string;
    url: string;
}

export interface DownloadLink {
    label: string;
    url: string;
}

export async function searchNkiri(query: string): Promise<MovieSearchResult[]> {
    const searchUrl = `https://thenkiri.com/?s=${urlencode(query)}&post_type=post`;
    console.log(`Searching Nkiri for: ${query}`);

    try {
        const { data } = await axiosInstance.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(data);
        const results: MovieSearchResult[] = [];

        $('article').each((_, element) => {
            const aTag = $(element).find('div.search-entry-inner div.thumbnail a');
            const imgTag = aTag.find('img');
            const href = aTag.attr('href');
            const title = imgTag.attr('alt') || $(element).find('.entry-title a').text().trim();

            if (href && title) {
                results.push({ title, url: href });
            }
        });

        return results;
    } catch (error) {
        console.error('Error searching Nkiri:', error);
        return [];
    }
}

export async function getDownloadLinks(movieUrl: string): Promise<DownloadLink[]> {
    try {
        const { data } = await axiosInstance.get(movieUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $ = cheerio.load(data);
        const finalLinks: DownloadLink[] = [];

        // 1. Check for specific download buttons/links on the page
        // Often series have links inside tables or listed as specific buttons
        $('a').each((_, element) => {
            const $a = $(element);
            const href = $a.attr('href');
            const text = $a.text().trim();

            if (href && (href.includes('nkiserv.com') || href.includes('ds2.nkiserv.com'))) {
                finalLinks.push({ label: text || 'Direct Link', url: href });
            }
        });

        // 2. Check for redirect buttons
        const downloadPages: { label: string, url: string }[] = [];
        $('section.elementor-section a.elementor-button').each((_, element) => {
            const $a = $(element);
            const href = $a.attr('href');
            // Try to find the label (e.g. "Download Episode 1")
            const label = $a.find('.elementor-button-text').text().trim() || $a.text().trim();
            
            if (href && (href.includes('downloadwella.com') || href.includes('wetafiles.com'))) {
                downloadPages.push({ label, url: href });
            }
        });

        for (const page of downloadPages) {
            console.log(`Processing redirect: ${page.url}`);
            try {
                const { data: pageData } = await axiosInstance.get(page.url);
                const $page = cheerio.load(pageData);
                
                const formData: Record<string, string> = {};
                $page('form[name="F1"] input[type="hidden"]').each((_, input) => {
                    const name = $page(input).attr('name');
                    const value = $page(input).attr('value') || '';
                    if (name) formData[name] = value;
                });

                if (Object.keys(formData).length > 0) {
                    const postRes = await axiosInstance.post(page.url, new URLSearchParams(formData).toString(), {
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Referer': page.url
                        },
                        maxRedirects: 0,
                        validateStatus: (status) => status >= 200 && status < 400
                    });

                    const location = postRes.headers.location;
                    if (location) {
                        let label = page.label;
                        // If label is too generic, try to get it from the final URL filename
                        if (label.toLowerCase().includes('direct link') || label.toLowerCase() === 'download') {
                            const filename = location.split('/').pop()?.split('?')[0] || '';
                            if (filename) label = filename;
                        }
                        finalLinks.push({ label, url: location });
                    }
                }
            } catch (postError: any) {
                if (postError.response && postError.response.status === 302 && postError.response.headers.location) {
                    const location = postError.response.headers.location;
                    let label = page.label;
                    if (label.toLowerCase().includes('direct link') || label.toLowerCase() === 'download') {
                        const filename = location.split('/').pop()?.split('?')[0] || '';
                        if (filename) label = filename;
                    }
                    finalLinks.push({ label, url: location });
                }
            }
        }

        // De-duplicate by URL
        const seen = new Set();
        return finalLinks.filter(item => {
            const duplicate = seen.has(item.url);
            seen.add(item.url);
            return !duplicate;
        });
    } catch (error) {
        console.error('Error getting download links:', error);
        return [];
    }
}
