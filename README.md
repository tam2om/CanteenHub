# CanteenHub

**Employee Meal Selection & Canteen Management System**

CanteenHub is a standalone internal web application for managing employee meal selections and canteen operations.

## Overview

The company provides meals to employees. For lunch, two meal options are provided each day. Employees who are eligible for a meal must log in and select their preference:
- Option 1
- Option 2
- No Preference

The system determines meal eligibility based on employee roster type and daily shift assignments.

## Employee Roster Types

### Regular
Regular employees work Sunday through Thursday and are meal eligible on those days.
- Sunday–Thursday: Meal eligible
- Friday–Saturday: Not meal eligible

### Shift
Shift employees are controlled by their daily shift roster.
- Day shift: Meal eligible
- Night shift: Meal eligible
- Off: Not meal eligible

### Amman HQ
Employees whose roster type is "Amman HQ" do not receive company meals. They can log in but cannot select meals.

## Technology Stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Cloudflare Workers (Hono framework)
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2 (for Excel imports)
- **Hosting**: Cloudflare Pages/Workers

## Project Structure

```
canteenhub/
├── src/
│   ├── frontend/          # React frontend application
│   ├── worker/            # Cloudflare Worker API
│   └── shared/            # Shared types between frontend and worker
├── migrations/            # D1 database migrations
├── tests/                 # Unit and integration tests
├── docs/                  # Documentation
└── public/                # Static assets
```

## Development

### Prerequisites

- Node.js 18+
- npm or pnpm
- Cloudflare account with Wrangler CLI installed

### Local Setup

```bash
# Install dependencies
npm install

# Create local D1 database
wrangler d1 create canteenhub-local

# Update wrangler.toml with the database ID

# Run migrations
wrangler d1 execute canteenhub-local --local --file=migrations/0001_initial_schema.sql

# Start development server
npm run dev
```

### Testing

```bash
# Run type checking
npm run typecheck

# Run linting
npm run lint

# Run tests
npm test
```

### Building

```bash
# Build frontend
npm run build:frontend

# Build worker
npm run build:worker
```

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for deployment instructions.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Database Schema](docs/DATABASE.md)
- [Business Rules](docs/BUSINESS-RULES.md)
- [Eligibility Engine](docs/ELIGIBILITY.md)
- [API Documentation](docs/API.md)

## License

Internal company use only.
