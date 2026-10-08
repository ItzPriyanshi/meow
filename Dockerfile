# Use the official Bun image (Debian-based, which helps with native modules like 'canvas')
FROM oven/bun:1

# Set the working directory inside the container
WORKDIR /app

# Copy package files first to leverage Docker layer caching
# The asterisk (*) ensures it works even if bun.lockb doesn't exist yet
COPY package.json bun.lockb* ./

# Install dependencies using Bun
RUN bun install --frozen-lockfile

# Copy the rest of the application source code
COPY . .

# Build the Next.js application
RUN bun run build

# Expose the necessary ports 
# (Next.js defaults to 3000. Adjust the second port if Elysia runs on something else, like 8080)
EXPOSE 3000
EXPOSE 8080

# Run the start script which triggers concurrently for both Elysia and Next.js
CMD ["bun", "run", "start"]
