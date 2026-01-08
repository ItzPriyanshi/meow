// handler/protection.ts

// --- Configuration ---
const WINDOW_MS = 60 * 1000;        // 1 Minute Window
const MAX_REQUESTS = 80;            // Max requests per minute per IP
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Cleanup idle IPs every 5 minutes
const STRICT_BOT_BLOCKING = false;  // Set to 'true' to block Python/Curl/Go scripts

// --- State Management ---
const rateLimitMap = new Map<string, number[]>();
const blockedIps = new Set<string>(); 
const trustedIps = new Set<string>(["127.0.0.1", "::1", "localhost"]);

// --- Scheduled Memory Cleanup ---
// Uses a timer instead of random chance for reliable memory management
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [ip, timestamps] of rateLimitMap.entries()) {
        // Keep only timestamps currently inside the window
        const validTimestamps = timestamps.filter(t => t > now - WINDOW_MS);
        
        if (validTimestamps.length === 0) {
            rateLimitMap.delete(ip);
            cleanedCount++;
        } else {
            rateLimitMap.set(ip, validTimestamps);
        }
    }
    // Uncomment for debugging:
    // if (cleanedCount > 0) console.log(`[Protection] 🧹 Cleaned ${cleanedCount} idle IPs.`);
}, CLEANUP_INTERVAL);

/**
 * Validates if the IP is allowed to make a request.
 * Checks Blacklist -> Whitelist -> Rate Limit.
 */
export function checkRateLimit(ip: string): boolean {
    // 1. Blocked IPs are rejected immediately
    if (blockedIps.has(ip)) return false;

    // 2. Trusted IPs bypass all rate limits
    if (trustedIps.has(ip)) return true;

    const now = Date.now();
    const requestTimestamps = rateLimitMap.get(ip) || [];

    // Filter out requests older than the window
    const requestsInWindow = requestTimestamps.filter(time => time > now - WINDOW_MS);

    // 3. Check if limit exceeded
    if (requestsInWindow.length >= MAX_REQUESTS) {
        // Security Feature: Auto-ban if they flood excessively (3x the limit)
        if (requestsInWindow.length > MAX_REQUESTS * 3) {
            console.warn(`[Protection] 🛡️ Auto-blocking flooding IP: ${ip}`);
            blockedIps.add(ip);
        }
        return false;
    }

    // Update the map
    requestsInWindow.push(now);
    rateLimitMap.set(ip, requestsInWindow);

    return true;
}

/**
 * Heuristic analysis to detect spam bots or malicious payloads.
 */
export function isSpam(req: Request): boolean {
    const userAgent = (req.headers.get("user-agent") || "").toLowerCase();
    const url = req.url.toLowerCase();

    // 1. Missing or suspicious User-Agent length
    if (!userAgent) return true;
    if (userAgent.length < 5) return true;

    // 2. Block generic script bots (Optional: Enable via STRICT_BOT_BLOCKING constant)
    const botPatterns = [
        "python-requests",
        "aiohttp",
        "scrapy",
        "curl/",
        "wget/",
        "httpie",
        "go-http-client",
        "java/",
        "axios"
    ];

    if (STRICT_BOT_BLOCKING) {
         if (botPatterns.some(p => userAgent.includes(p))) {
            return true;
         }
    }

    // 3. Basic WAF: Check for malicious payload signatures in the URL
    // Detects SQL Injection, XSS, and Path Traversal attempts
    const attackSignatures = [
        "union select", 
        "/etc/passwd", 
        "<script", 
        "javascript:", 
        "eval(",
        "document.cookie",
        "../..",
        "xp_cmdshell"
    ];
    
    if (attackSignatures.some(sig => url.includes(sig))) {
        console.warn(`[Protection] ⚔️ Blocked potential attack signature in URL: ${url}`);
        return true;
    }

    return false;
}

/**
 * Helper to manage lists at runtime (e.g. from an Admin API endpoint)
 */
export const ProtectionManager = {
    blockIp: (ip: string) => blockedIps.add(ip),
    unblockIp: (ip: string) => blockedIps.delete(ip),
    trustIp: (ip: string) => trustedIps.add(ip),
    untrustIp: (ip: string) => trustedIps.delete(ip),
    getStats: () => ({
        blockedCount: blockedIps.size,
        trustedCount: trustedIps.size,
        activeRateLimitedIps: rateLimitMap.size
    })
};