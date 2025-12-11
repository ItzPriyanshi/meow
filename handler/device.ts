export function getDeviceInfo(req: Request) {
    const userAgent = req.headers.get("user-agent") || "Unknown";
    let device = "Unknown";
    let os = "Unknown";
    let browser = "Unknown";

    if (/mobile/i.test(userAgent)) device = "Mobile";
    else if (/tablet/i.test(userAgent)) device = "Tablet";
    else device = "Desktop";

    if (/windows/i.test(userAgent)) os = "Windows";
    else if (/mac/i.test(userAgent)) os = "MacOS";
    else if (/linux/i.test(userAgent)) os = "Linux";
    else if (/android/i.test(userAgent)) os = "Android";
    else if (/ios/i.test(userAgent)) os = "iOS";

    if (/chrome/i.test(userAgent)) browser = "Chrome";
    else if (/firefox/i.test(userAgent)) browser = "Firefox";
    else if (/safari/i.test(userAgent)) browser = "Safari";
    else if (/edge/i.test(userAgent)) browser = "Edge";

    return {
        userAgent,
        device,
        os,
        browser
    };
}
