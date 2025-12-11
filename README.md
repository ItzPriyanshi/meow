# MeowDL API v4.6

<div align="center">
  <svg width="120" height="120" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM10 17L5 12L6.41 10.59L10 14.17L17.59 6.58L19 8L10 17Z" fill="#A855F7" />
  </svg>

  <h1 style="color: #A855F7; font-weight: bold;">MeowDL</h1>
  <p><strong>Advanced Multi-Platform Downloader API & Dashboard</strong></p>

  <p>
    <a href="https://github.com/MeowGurl">
      <img src="https://img.shields.io/badge/Author-MeowGurl-purple?style=for-the-badge&logo=github" alt="Author">
    </a>
    <a href="mailto:its.meowgurl@gmail.com">
      <img src="https://img.shields.io/badge/Email-its.meowgurl%40gmail.com-red?style=for-the-badge&logo=gmail" alt="Email">
    </a>
    <img src="https://img.shields.io/badge/Version-4.6-blue?style=for-the-badge" alt="Version">
  </p>
</div>

---

## 🚀 Features

- **Multi-Platform Support**: Download from YouTube, Instagram, Facebook, TikTok, Twitter/X, Pinterest.
- **High Performance**: Built with [Bun](https://bun.sh) and [ElysiaJS](https://elysiajs.com).
- **Smart Caching**: Unique session management with metadata caching for lightning-fast repeated requests.
- **Modern Dashboard**: Next.js 15 powered dashboard with real-time system stats and cinematic UI.
- **Advanced Audio Processing**: FFmpeg integration for high-quality audio extraction and conversion (MP3, Opus, M4A, WAV).
- **Security**: Rate limiting, IP detection, and device fingerprinting.

## 🛠️ Tech Stack

- **Backend**: Bun, ElysiaJS, YouTube.js
- **Frontend**: Next.js, React, TailwindCSS, Framer Motion
- **Tools**: FFmpeg, TypeScript

## 📦 Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/MeowGurl/meowdl-api.git
    cd meowdl-api
    ```

2.  **Install dependencies**
    ```bash
    bun install
    ```

3.  **Run Development Server**
    ```bash
    bun run dev
    ```
    This will start both the API (port 3041) and the Frontend (port 3000).

4.  **Build for Production**
    ```bash
    bun run build
    bun start
    ```

## 📖 API Documentation

### YouTube Download
`GET /yt`

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `url` | `string` | YouTube video URL (Required) |
| `format` | `string` | `mp4`, `mp3`, `m4a`, `opus`, `wav` (Default: `mp4`) |
| `quality` | `string` | Video quality (e.g., `1080`, `720`). Capped at 1080p. |

**Response:**
```json
{
  "status": "ok",
  "videoId": "...",
  "downloadLink": "http://host/stream/video/uuid",
  ...
}
```

### System Stats
`GET /api/stats`

Returns CPU, Memory, and Uptime statistics.

## 👥 Authors

- **@MeowGurl** - Founder & Lead Developer
- **AjKing** - Co-Founder

## 📄 License

This project is licensed under the MIT License.
