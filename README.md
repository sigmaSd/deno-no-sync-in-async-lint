# Deno No-Sync-in-Async Lint Plugin

Detects synchronous/blocking operations within async functions to prevent accidentally blocking the event loop.

## Installation

```json
{
  "lint": {
    "plugins": [
      "jsr:@sigmasd/deno-no-sync-in-async-lint@0.5.0"
    ]
  }
}
```

## Usage

### As a Lint Plugin

The plugin automatically runs as part of `deno lint`, detecting:

1. Deno sync operations:
```typescript
async function readFile() {
  // Error: Sync operation readFileSync found in async function readFile
  const content = Deno.readFileSync("file.txt");
}
```

2. Blocking function calls:
```typescript
async function processData() {
  // Error: Blocking function 'readFile' called in async function 'processData'
  readFile();
}
```

Valid code:
```typescript
// Sync operations in normal functions - OK
function normalFunction() {
  const content = Deno.readFileSync("file.txt");
}

// Async operations in async functions - OK
async function goodExample() {
  const content = await Deno.readFile("file.txt");
}
```

### Analyzer CLI

You can also use the analyzer directly to inspect files:

```bash
deno run analyzer.ts <file-path>
```

Output example:
```
Analyzing file.ts...
Found blocking functions:
- readFile (file.ts:10:2)
- processSync (utils.ts:15:4)
```

## How it Works

Uses static analysis to:
- Identify blocking function patterns
- Track function definitions and locations
- Detect sync operations in async contexts

## License

MIT License
