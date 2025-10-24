// api/utils.ts

/**
 * Extracts a unique client identifier from the request object for rate-limiting.
 * It checks for common proxy headers first.
 *
 * @param request The standard Request object from the route handler.
 * @returns A string representing the client ID (usually the IP address).
 */
export function getClientId(request: Request): string {
    // Try 'x-forwarded-for'. This header can be a comma-separated list
    // (e.g., "client, proxy1, proxy2"). The first IP is the originating client.
    const xff = request.headers.get('x-forwarded-for');
    if (xff) {
        return xff.split(',')[0].trim();
    }

    // Try 'x-real-ip', a common non-standard header used by
    // reverse proxies like Nginx.
    const realIp = request.headers.get('x-real-ip');
    if (realIp) {
        return realIp.trim();
    }

    // Fallback for local development or direct connections where headers
    // aren't set. All local requests will share the same ID.
    return '_local_dev_client_';
}

// You can add any other shared utility functions here in the future.