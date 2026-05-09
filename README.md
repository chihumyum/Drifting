# Drifting - Electron Desktop App

A creative writing and storytelling tool built with Electron, React, and TypeScript.

## Overview

Drifting is a desktop application designed for writers and storytellers to organize their creative projects. It provides tools for managing:

- **Nodes**: Chapters and scenes organized hierarchically
- **Elements**: Characters, locations, items with custom categories
- **Threads**: Story threads that connect different parts of your narrative
- **Timeline**: Visual timeline of your story structure
- **Rich Text Editor**: Powered by Tiptap for a smooth writing experience

## Tech Stack

- **Electron**: Cross-platform desktop framework
- **React 19**: UI framework
- **TypeScript**: Type safety
- **Vite**: Build tool and dev server
- **Electron Forge**: Packaging and distribution
- **Better-SQLite3**: Local database for storing project data
- **Tailwind CSS**: Styling
- **Zustand**: State management
- **React Query**: Data fetching and caching
- **Tiptap**: Rich text editor

## Development

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm

### Installation

```bash
# Install dependencies
pnpm install

# Start development server
pnpm start
```

### Build

```bash
# Package the app for current platform
pnpm package

# Create distributable packages
pnpm make
```

## Project Structure

```
core/
├── src/
│   ├── main/              # Electron main process
│   │   ├── main.ts        # Main entry point
│   │   ├── preload.ts     # Preload script (IPC bridge)
│   │   └── database.ts    # Database IPC handlers
│   └── renderer/          # React application (renderer process)
│       ├── main.tsx       # React entry point
│       ├── App.tsx        # Main App component
│       ├── components/    # React components
│       ├── views/         # Page views
│       ├── lib/           # Utilities and helpers
│       ├── store/         # Zustand stores
│       ├── hooks/         # Custom React hooks
│       ├── domain/        # Domain models
│       ├── repositories/  # Data access layer
│       ├── services/      # Business logic
│       ├── schema/        # Database schema
│       └── styles/        # Global styles
├── forge.config.ts        # Electron Forge configuration
├── vite.*.config.ts       # Vite configurations
├── tailwind.config.js     # Tailwind CSS configuration
└── package.json

```

## Database

The app uses SQLite with Better-SQLite3 for data persistence. Database files are stored in the user's application data directory:

- macOS: `~/Library/Application Support/Drifting/databases/`
- Windows: `%APPDATA%/Drifting/databases/`
- Linux: `~/.config/Drifting/databases/`

Each user and project combination gets its own database file: `{userId}_{projectId}.db`

## Features

- **Offline-first**: All data stored locally in SQLite
- **Cross-platform**: Windows, macOS, Linux
- **User authentication**: Local and server sync support
- **Rich text editing**: Markdown support, formatting, links
- **Element management**: Organize characters, locations, items
- **Thread tracking**: Track story threads across nodes
- **Timeline view**: Visual representation of story structure
- **Export**: Export projects to various formats

## License

MIT

## Author

chihumyum (108172547+chihumyum@users.noreply.github.com)
