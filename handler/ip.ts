import { Context } from "elysia";

export function getIp(req: Request): string {
  // Ordered by priority: Cloudflare -> Real IP -> General Proxies -> Enterprise Load Balancers
  const headers = [
    "cf-connecting-ip",
    "x-real-ip",
    "x-forwarded-for",
    "true-client-ip",
    "x-client-ip",
    "x-cluster-client-ip",
    "forwarded-for",
    "forwarded"
  ];

  for (const header of headers) {
    const value = req.headers.get(header);
    if (value) {
      // If multiple IPs are chained (e.g., proxy1, proxy2), take the first one (original client)
      const ip = value.split(",")[0].trim();
      if (ip) return ip;
    }
  }

  return "unknown";
}

export async function getIpInfo(ip: string) {
  // Handle local and private IP ranges immediately to prevent API waste
  if (
    !ip || 
    ip === "unknown" || 
    ip === "127.0.0.1" || 
    ip === "::1" || 
    ip.startsWith("192.168.") || 
    ip.startsWith("10.") ||
    ip.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)
  ) {
    return {
      ip: ip || "unknown",
      city: "Localhost / Private Network",
      region: "Local",
      country: "Local",
      countryCode: "LOCAL",
      lat: 0,
      lon: 0,
      isp: "Internal Network",
      org: "Localhost",
      timezone: "UTC",
      isMobile: false,
      isProxy: false,
      isHosting: false
    };
  }

  try {
    // Primary API: ip-api.com (Provides extensive details including VPN/Proxy and Datacenter detection)
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query`);
    
    if (response.ok) {
      const data = await response.json();
      if (data.status === "success") {
        return {
          ip: data.query,
          city: data.city || "Unknown",
          region: data.regionName || "Unknown",
          country: data.country || "Unknown",
          countryCode: data.countryCode || "Unknown",
          lat: data.lat || 0,
          lon: data.lon || 0,
          isp: data.isp || "Unknown ISP",
          org: data.org || data.as || "Unknown Org",
          timezone: data.timezone || "UTC",
          isMobile: data.mobile || false,
          isProxy: data.proxy || false,    // Detects VPNs, TOR, and Proxies
          isHosting: data.hosting || false // Detects Datacenters (AWS, DigitalOcean, etc.)
        };
      }
    }
  } catch (e) {
    console.warn(`[IP Service] Primary API failed for ${ip}, falling back to ipinfo.io...`);
  }

  // Fallback API: ipinfo.io (Original baseline)
  try {
    const fallbackRes = await fetch(`https://ipinfo.io/${ip}/json`);
    if (fallbackRes.ok) {
      const data = await fallbackRes.json();
      const [lat, lon] = (data.loc || "0,0").split(",");
      
      return {
        ip: data.ip,
        city: data.city || "Unknown",
        region: data.region || "Unknown",
        country: data.country || "Unknown",
        countryCode: data.country || "Unknown",
        lat: parseFloat(lat),
        lon: parseFloat(lon),
        isp: data.org ? data.org.split(" ").slice(1).join(" ") : "Unknown ISP",
        org: data.org || "Unknown Org",
        timezone: data.timezone || "UTC",
        isMobile: false, 
        isProxy: false,
        isHosting: false
      };
    }
  } catch (e) {
    console.error(`[IP Service] All IP APIs failed for ${ip}`);
  }

  // Absolute Fallback
  return { 
    ip, 
    error: "Could not fetch details", 
    city: "Unknown", 
    country: "Unknown", 
    isp: "Unknown" 
  };
}
