# Zup Terminal Backend

Backend server for Zuperior Terminal built with Express.js and TypeScript.

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   Copy `.env.example` to `.env` and fill in the required values:
   ```bash
   cp .env.example .env
   ```

3. **Database Setup**
   ```bash
   # Generate Prisma client
   npm run db:generate
   
   # Run migrations (if needed)
   npm run db:migrate
   ```

4. **Start Development Server**
   ```bash
   npm run dev
   ```

   The server will start on `http://localhost:3001` (or the port specified in `.env`)

## API Endpoints

### Authentication

- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration
- `POST /api/auth/logout` - User logout
- `GET /api/auth/me` - Get current authenticated user
- `POST /api/auth/sso-login` - SSO login from CRM

### Health Check

- `GET /health` - Server health check

## Project Structure

```
zup-terminal-backend/
├── src/
│   ├── server.ts              # Express server entry point
│   ├── middleware/
│   │   ├── auth.ts            # JWT authentication middleware
│   │   └── errorHandler.ts    # Error handling middleware
│   ├── routes/
│   │   └── auth.ts            # Authentication routes
│   └── lib/
│       ├── db.ts              # Prisma client
│       ├── auth.ts             # Auth utilities
│       ├── env.ts              # Environment validation
│       └── default-favorites.ts # Default favorites utility
├── prisma/
│   └── schema.prisma          # Database schema
├── .env.example               # Environment variables template
├── package.json
└── tsconfig.json
```

## Environment Variables

See `.env.example` for all required environment variables.

## Development

- **Watch mode**: `npm run dev` (uses tsx for hot reload)
- **Build**: `npm run build`
- **Start production**: `npm start`

## Database

This project uses Prisma ORM with PostgreSQL. The schema is shared with the `zuperior-terminal` project.
