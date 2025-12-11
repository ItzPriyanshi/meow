# Use the official Bun image
FROM oven/bun:1.2.2-alpine

# Set working directory
WORKDIR /app

# Install system dependencies (ffmpeg might need glibc compatibility on Alpine, or use Debian variant)
# We'll use debian based bun image to be safe with ffmpeg-static and node compat
FROM oven/bun:1.2.2-debian

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Build Next.js
# Next.js requires NODE_ENV=production for build optimization
ENV NODE_ENV=production
RUN bun run build

# Expose the port Next.js listens on
ENV PORT=3000
EXPOSE 3000

# Start command
CMD ["bun", "run", "start"]
