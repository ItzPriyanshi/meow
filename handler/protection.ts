import { Context } from "elysia";

const rateLimitMap = new Map<string, number[]>();
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 60; // 60 requests per minute

export function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const requests = rateLimitMap.get(ip) || [];

    // Filter out old requests
    const recentRequests = requests.filter(time => time > now - WINDOW_MS);

    if (recentRequests.length >= MAX_REQUESTS) {
        return false;
    }

    recentRequests.push(now);
    rateLimitMap.set(ip, recentRequests);

    // Cleanup old entries periodically
    if (Math.random() < 0.01) { // 1% chance to cleanup
        for (const [key, reqs] of rateLimitMap.entries()) {
            if (reqs.length === 0 || reqs[reqs.length - 1] < now - WINDOW_MS) {
                rateLimitMap.delete(key);
            }
        }
    }

    return true;
}

export function isSpam(req: Request): boolean {
    // Basic spam check logic (e.g. check for suspicious headers or patterns)
    const userAgent = req.headers.get("user-agent") || "";
    if (userAgent.length < 5) return true;
    if (userAgent.includes("curl") || userAgent.includes("python") || userAgent.includes("bot")) {
        // Allow common bots if needed, or flag them
        // For now, we just return false but this can be expanded
    }
    return false;
}
