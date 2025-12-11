import os from "os";

export function getSystemStats() {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
        cpu: {
            model: cpus[0].model,
            cores: cpus.length,
            usage: loadAvg[0], // 1 minute load average
        },
        memory: {
            total: totalMem,
            free: freeMem,
            used: totalMem - freeMem,
            percentage: ((totalMem - freeMem) / totalMem * 100).toFixed(2)
        },
        uptime: os.uptime(),
        platform: os.platform(),
        arch: os.arch()
    };
}
