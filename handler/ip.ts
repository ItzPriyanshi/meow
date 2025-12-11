import { Context } from "elysia";

export function getIp(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for");
  const realIp = req.headers.get("x-real-ip");
  const cfConnecting = req.headers.get("cf-connecting-ip");

  return forwarded?.split(",")[0].trim() || realIp || cfConnecting || "unknown";
}

export async function getIpInfo(ip: string) {
    if (ip === "unknown" || ip === "127.0.0.1" || ip === "::1") {
        return {
            ip,
            city: "Localhost",
            region: "Localhost",
            country: "Localhost",
            loc: "0,0",
            org: "Localhost",
            timezone: "UTC"
        }
    }
    try {
        const response = await fetch(`https://ipinfo.io/${ip}/json`);
        if (response.ok) {
            return await response.json();
        }
    } catch (e) {
        console.error("Failed to fetch IP info", e);
    }
    return { ip, error: "Could not fetch details" };
}
