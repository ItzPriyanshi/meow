"use client";

import { motion } from "framer-motion";
import { ArrowRight, SkipForward } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-gray-900 via-purple-950 to-black p-4 overflow-hidden relative">
      {/* Background Anime Style Elements */}
      <motion.div
        className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-purple-500 rounded-full mix-blend-screen filter blur-[100px] opacity-20"
        animate={{
          scale: [1, 1.2, 1],
          x: [0, 50, 0],
          y: [0, 30, 0],
        }}
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
      <motion.div
        className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-pink-500 rounded-full mix-blend-screen filter blur-[100px] opacity-20"
        animate={{
          scale: [1, 1.2, 1],
          x: [0, -50, 0],
          y: [0, -30, 0],
        }}
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 5,
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="z-10 w-full max-w-md bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl relative"
      >
        {/* Logo Area */}
        <div className="flex flex-col items-center mb-8">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{
              type: "spring",
              stiffness: 260,
              damping: 20,
              delay: 0.2,
            }}
            className="w-24 h-24 bg-gradient-to-tr from-purple-500 to-pink-500 rounded-full flex items-center justify-center mb-4 shadow-lg shadow-purple-500/50"
          >
             {/* Simple MeowDL Logo Representation */}
             <svg width="60" height="60" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-white">
                <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM10 17L5 12L6.41 10.59L10 14.17L17.59 6.58L19 8L10 17Z" fill="white" />
             </svg>
          </motion.div>
          <motion.h1
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400 font-sans tracking-tight"
          >
            MeowDL
          </motion.h1>
          <motion.p
             initial={{ opacity: 0 }}
             animate={{ opacity: 1 }}
             transition={{ delay: 0.6 }}
            className="text-gray-400 text-sm mt-2"
          >
            Version 4.6
          </motion.p>
        </div>

        {/* Message */}
        <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.7 }}
            className="mb-8 bg-purple-900/30 border border-purple-500/30 p-4 rounded-lg text-xs text-purple-200 leading-relaxed"
        >
            <p>
                MeowDL Team is going to add a Login Page in the Dashboard. This is a required update for future versions. In upcoming updates, logging in will be mandatory to obtain an API Key, and you will not be able to use our APIs without one.
            </p>
        </motion.div>

        {/* Form Mockup (Disabled for now) */}
        <div className="space-y-4 mb-6 opacity-50 pointer-events-none grayscale">
            <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Email</label>
                <input type="email" className="w-full bg-black/20 border border-white/10 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-purple-500" placeholder="Enter your email" />
            </div>
             <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Password</label>
                <input type="password" className="w-full bg-black/20 border border-white/10 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-purple-500" placeholder="••••••••" />
            </div>
             <button className="w-full bg-gradient-to-r from-purple-600 to-pink-600 text-white py-2 rounded-lg font-medium text-sm shadow-lg">
                Login
            </button>
        </div>

        <div className="text-center text-xs text-gray-500 mb-4">
            (Login currently disabled for preview)
        </div>

        {/* Skip Button */}
        <Link href="/dashboard" className="block">
            <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="w-full group relative overflow-hidden bg-white/10 border border-white/20 hover:bg-white/20 text-white py-3 rounded-xl font-medium text-sm transition-all duration-300 flex items-center justify-center gap-2"
            >
                <span>Skip For Now</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </motion.button>
        </Link>
      </motion.div>

        <div className="absolute bottom-4 text-center text-[10px] text-gray-600">
            Author & Founder @MeowGurl & AjKing
        </div>
    </div>
  );
}
