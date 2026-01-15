import moment from "moment-timezone";

const COOKIE = "_ga=GA1.1.1765779302.1752765382; session=1d04c5db-eaf8-47df-a739-e9425cc6da6c; session.sig=mGXqvo2TEdy6dDcQin16C-4G664; _ga_GDNE9EKYHZ=GS2.1.s1752928624$o7$g1$t1752928647$j37$l0$h0";

const HEADERS = {
    "authority": "congdong.ff.garena.vn",
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "cookie": COOKIE,
    "origin": "https://congdong.ff.garena.vn",
    "referer": "https://congdong.ff.garena.vn/tinh-diem",
    "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36"
};

export default async function ffHandler(accountId: string, timeChoice: string = "TUY_CHINH") {
    const timeZone = "Asia/Ho_Chi_Minh";
    let start: moment.Moment;
    let end: moment.Moment;

    switch (timeChoice) {
        case "HOM_NAY": start = moment().tz(timeZone).startOf("day"); end = moment().tz(timeZone).add(1, "days").startOf("day"); break;
        case "HOM_QUA": start = moment().tz(timeZone).subtract(1, "days").startOf("day"); end = moment().tz(timeZone).startOf("day"); break;
        case "7_NGAY": start = moment().tz(timeZone).subtract(6, "days").startOf("day"); end = moment().tz(timeZone).add(1, "days").startOf("day"); break;
        case "TUAN_NAY": start = moment().tz(timeZone).startOf("isoWeek"); end = moment().tz(timeZone).endOf("isoWeek").add(1, "second"); break;
        case "THANG_NAY": start = moment().tz(timeZone).startOf("month"); end = moment().tz(timeZone).add(1, "month").startOf("month"); break;
        case "TUY_CHINH": 
        default:
            start = moment.tz("2025-08-17 13:00:00", "YYYY-MM-DD HH:mm:ss", timeZone); 
            end = moment.tz("2025-08-17 14:30:00", "YYYY-MM-DD HH:mm:ss", timeZone); 
            break;
    }

    const findMatchPayload = { accountId: accountId, startTime: start.unix(), endTime: end.unix() };
    
    const findMatchResponse = await fetch("https://congdong.ff.garena.vn/league-score-api/player/find-match", {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(findMatchPayload)
    });

    if (!findMatchResponse.ok) throw new Error(`Find match failed: ${findMatchResponse.status}`);
    const findMatchData = await findMatchResponse.json() as any;
    
    const foundMatches = findMatchData?.matches;
    if (!foundMatches || foundMatches.length === 0) {
        return { success: false, message: "No matches found for this ID in the selected timeframe." };
    }

    const matchIds = foundMatches.map((match: any) => match.id);
    
    const matchDetailPromises = matchIds.map(async (id: string) => {
        const res = await fetch("https://congdong.ff.garena.vn/league-score-api/match", {
            method: "POST",
            headers: HEADERS,
            body: JSON.stringify({ matchId: id })
        });
        return res.json();
    });

    const matchDetailResponses = await Promise.all(matchDetailPromises);
    const matches = matchDetailResponses.map((data: any) => data.match);

    let playerNickname = "N/A";
    const mainPlayerEntry = matches[0]?.leaderboard?.flatMap((team: any) => team.players).find((p: any) => p.accountId == accountId);
    if (mainPlayerEntry) playerNickname = mainPlayerEntry.nickname;

    let totalKills = 0, totalScore = 0, totalBooyahs = 0;
    const totalMatches = matches.length;
    const playerStats = new Map();

    for (const match of matches) {
        if (!match || !match.leaderboard) continue;
        const mainPlayerTeam = match.leaderboard.find((team: any) => team.players.some((p: any) => p.accountId == accountId));
        if (mainPlayerTeam) {
            const mainPlayerInTeam = mainPlayerTeam.players.find((p: any) => p.accountId == accountId);
            if (mainPlayerInTeam && mainPlayerInTeam.killCount) totalKills += mainPlayerInTeam.killCount;
            if (mainPlayerTeam.score) totalScore += mainPlayerTeam.score;
            if (mainPlayerTeam.rank === 1) totalBooyahs++;
        }
        for (const team of match.leaderboard) {
            for (const player of team.players) {
                const id = player.accountId;
                if (!id) continue;
                if (!playerStats.has(id)) playerStats.set(id, { name: player.nickname, kills: 0, booyahs: 0 });
                const stats = playerStats.get(id);
                if (player.killCount) stats.kills += player.killCount;
                if (team.rank === 1) stats.booyahs++;
            }
        }
    }

    const allPlayers = Array.from(playerStats.values());
    const killKing = allPlayers.reduce((max, p) => p.kills > max.kills ? p : max, { name: "N/A", kills: -1 });
    const booyahKing = allPlayers.reduce((max, p) => p.booyahs > max.booyahs ? p : max, { name: "N/A", booyahs: -1 });

    return {
        success: true,
        player: {
            nickname: playerNickname,
            accountId: accountId
        },
        timeframe: {
            start: start.format("DD/MM/YYYY HH:mm:ss"),
            end: moment(end).subtract(1, "second").format("DD/MM/YYYY HH:mm:ss")
        },
        stats: {
            matches: totalMatches,
            score: totalScore,
            kills: totalKills,
            booyahs: totalBooyahs,
            booyahRate: totalMatches > 0 ? ((totalBooyahs / totalMatches) * 100).toFixed(2) + "%" : "0%"
        },
        highlights: {
            killKing,
            booyahKing
        }
    };
}
