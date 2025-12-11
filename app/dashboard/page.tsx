"use client";

import { motion } from "framer-motion";
import {
  Activity,
  Cpu,
  Database,
  Server,
  ShieldCheck,
  Zap,
  Github,
  Mail,
  Code
} from "lucide-react";
import { useEffect, useState } from "react";

interface SystemStats {
  cpu: {
    model: string;
    cores: number;
    usage: number;
  };
  memory: {
    total: number;
    free: number;
    used: number;
    percentage: string;
  };
  uptime: number;
  platform: string;
  arch: string;
}

export default function Dashboard() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate initial loading
    setTimeout(() => {
        fetchStats();
    }, 2000); // 2 seconds fake loading for "Checking browser backend"

    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/stats");
      if (res.ok) {
        const data = await res.json();
        setStats(data);
        setLoading(false);
      }
    } catch (error) {
      console.error("Failed to fetch stats", error);
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-950 text-white">
        <motion.div
          animate={{
            rotate: 360,
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: "linear",
          }}
          className="mb-8"
        >
          <div className="w-16 h-16 border-4 border-purple-500 border-t-transparent rounded-full" />
        </motion.div>
        <motion.h2
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="text-xl font-mono text-purple-400"
        >
            Checking Browser Backend...
        </motion.h2>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6 pb-20">
      <header className="flex justify-between items-center mb-12">
        <div className="flex items-center gap-4">
             <div className="w-12 h-12 bg-gradient-to-tr from-purple-500 to-pink-500 rounded-full flex items-center justify-center shadow-lg shadow-purple-500/50">
                 <span className="font-bold text-xl">M</span>
            </div>
            <div>
                 <h1 className="text-2xl font-bold">MeowDL Dashboard</h1>
                 <p className="text-xs text-gray-400">v4.6</p>
            </div>
        </div>
        <div className="flex gap-4">
            <a href="https://github.com/MeowGurl" target="_blank" className="p-2 bg-white/5 rounded-full hover:bg-white/10 transition-colors">
                <Github className="w-5 h-5" />
            </a>
             <a href="mailto:its.meowgurl@gmail.com" className="p-2 bg-white/5 rounded-full hover:bg-white/10 transition-colors">
                <Mail className="w-5 h-5" />
            </a>
        </div>
      </header>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
        <StatCard
            title="CPU Usage"
            value={stats ? `${(stats.cpu.usage * 10).toFixed(1)}%` : "0%"}
            icon={<Cpu className="text-purple-400" />}
            delay={0}
        />
        <StatCard
            title="Memory Used"
            value={stats ? `${(stats.memory.used / 1024 / 1024 / 1024).toFixed(1)} GB` : "0 GB"}
            subValue={stats ? `${stats.memory.percentage}%` : ""}
            icon={<Database className="text-pink-400" />}
            delay={0.1}
        />
        <StatCard
            title="System Uptime"
            value={stats ? formatUptime(stats.uptime) : "0s"}
            icon={<Activity className="text-blue-400" />}
            delay={0.2}
        />
        <StatCard
            title="Platform"
            value={stats ? `${stats.platform} (${stats.arch})` : "Unknown"}
            icon={<Server className="text-green-400" />}
            delay={0.3}
        />
      </div>

      {/* API Documentation Section */}
      <div className="mb-12">
        <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Code className="text-purple-400" /> API Documentation
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ApiCard
                method="GET"
                endpoint="/yt"
                description="Download YouTube Video/Audio"
                params={[
                    { name: "url", type: "string", required: true },
                    { name: "format", type: "mp3|mp4|...", required: false },
                    { name: "quality", type: "1080|720...", required: false }
                ]}
                color="border-red-500/50 bg-red-950/20"
            />
            <ApiCard
                method="GET"
                endpoint="/stream/audio/:id"
                description="Stream Audio File"
                params={[
                    { name: "id", type: "uuid", required: true }
                ]}
                color="border-blue-500/50 bg-blue-950/20"
            />
             <ApiCard
                method="GET"
                endpoint="/pin"
                description="Pinterest Downloader / Search"
                params={[
                    { name: "url", type: "string", required: false },
                    { name: "search", type: "string", required: false }
                ]}
                color="border-red-600/50 bg-red-900/20"
            />
             <ApiCard
                method="GET"
                endpoint="/api/stats"
                description="Get System Statistics"
                params={[]}
                color="border-green-500/50 bg-green-950/20"
            />
        </div>
      </div>

        {/* Cinematic Anime Style Section (Decorative) */}
      <motion.div
        initial={{ opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="relative h-64 rounded-3xl overflow-hidden mb-12 group"
      >
          <div className="absolute inset-0 bg-gradient-to-r from-purple-900 via-pink-900 to-black opacity-80 z-10" />
           {/* You would typically use an actual image here, but we use a gradient placeholder */}
          <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1578632767115-351597cf2477?q=80&w=2000&auto=format&fit=crop')] bg-cover bg-center opacity-40 group-hover:scale-105 transition-transform duration-1000" />

          <div className="relative z-20 h-full flex flex-col items-center justify-center text-center p-6">
              <h2 className="text-3xl md:text-5xl font-bold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-white to-purple-200">
                  Next Gen API Power
              </h2>
              <p className="max-w-2xl text-gray-300">
                  Experience lightning fast downloads with our advanced session management and caching system.
              </p>
          </div>
      </motion.div>

      <footer className="border-t border-white/10 pt-8 mt-12 text-center text-gray-500 text-sm">
        <p>MeowDL API Version 4.6</p>
        <div className="flex justify-center gap-6 mt-4">
            <div>
                <p className="text-white font-medium">Author & Founder</p>
                <p>@MeowGurl & AjKing</p>
            </div>
            <div>
                 <p className="text-white font-medium">Email</p>
                 <p>its.meowgurl@gmail.com</p>
                 <p>og.ajay.ofcl@gmail.com</p>
            </div>
        </div>
      </footer>
    </div>
  );
}

function StatCard({ title, value, subValue, icon, delay }: { title: string, value: string, subValue?: string, icon: React.ReactNode, delay: number }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay, duration: 0.5 }}
            className="bg-white/5 border border-white/10 rounded-2xl p-6 hover:bg-white/10 transition-colors"
        >
            <div className="flex justify-between items-start mb-4">
                <div className="p-3 bg-white/5 rounded-xl">
                    {icon}
                </div>
                {subValue && <span className="text-xs font-mono text-gray-400 bg-black/30 px-2 py-1 rounded">{subValue}</span>}
            </div>
            <h3 className="text-gray-400 text-sm mb-1">{title}</h3>
            <p className="text-2xl font-bold font-mono">{value}</p>
        </motion.div>
    )
}

function ApiCard({ method, endpoint, description, params, color }: { method: string, endpoint: string, description: string, params: {name: string, type: string, required: boolean}[], color: string }) {
     return (
        <motion.div
             whileHover={{ scale: 1.02 }}
             className={`border rounded-2xl p-6 ${color} backdrop-blur-sm`}
        >
            <div className="flex items-center gap-3 mb-4">
                <span className={`px-3 py-1 rounded-lg text-xs font-bold ${method === 'GET' ? 'bg-blue-500/20 text-blue-400' : 'bg-green-500/20 text-green-400'}`}>
                    {method}
                </span>
                <code className="text-sm font-mono text-white/90">{endpoint}</code>
            </div>
            <p className="text-gray-300 mb-4">{description}</p>
            {params.length > 0 && (
                <div className="space-y-2">
                    <p className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Parameters</p>
                    {params.map(p => (
                        <div key={p.name} className="flex items-center justify-between text-sm border-b border-white/5 pb-1">
                            <span className="font-mono text-purple-300">{p.name}</span>
                            <div className="flex gap-2">
                                <span className="text-gray-500">{p.type}</span>
                                {p.required && <span className="text-red-400 text-xs px-1 border border-red-400/30 rounded">REQ</span>}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </motion.div>
    )
}

function formatUptime(seconds: number) {
    const d = Math.floor(seconds / (3600*24));
    const h = Math.floor(seconds % (3600*24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    return `${d}d ${h}h ${m}m`;
}
