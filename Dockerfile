# Use the official Bun image (Debian-based)
FROM oven/bun:1

# Set the working directory inside the container
WORKDIR /app

# Copy package files first to leverage Docker layer caching
COPY package.json bun.lockb* ./

# Install dependencies
# (Note: If 'canvas' fails to build here, see the system dependencies note below)
RUN bun install --frozen-lockfile

# Copy the rest of the application source code
COPY . .

# Expose the port your Elysia app listens on (adjust if your app uses a different port)
EXPOSE 8080

# Run the Elysia backend directly
CMD ["bun", "run", "index.ts"]
