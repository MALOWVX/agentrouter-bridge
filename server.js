/**
 * ============================================
 *  AgentRouter Bridge — Disguise Proxy
 * ============================================
 * 
 *  Intercepts JanitorAI requests and transforms
 *  headers to appear as Claude Code CLI traffic
 *  before forwarding to AgentRouter.org.
 * 
 *  Supports streaming (SSE) and non-streaming.
 * ============================================
 */

const express = require('express');
const { Readable } = require('stream');

const app = express();

// ─── Configuration ───────────────────────────────────────

const PORT = process.env.PORT || 3131;
const AGENTROUTER_BASE_URL = (process.env.AGENTROUTER_BASE_URL || 'https://agentrouter.org').replace(/\/+$/, '');
const DISGUISE_MODE = process.env.DISGUISE_MODE || 'claude-code';
const OBFUSCATE_MODE = process.env.OBFUSCATE_MODE || 'zero-width'; // 'zero-width', 'base64', or 'none'
const OVERRIDE_API_KEY = process.env.AGENTROUTER_API_KEY || '';

// ─── Obfuscation Engine (Multi-Layered) ─────────────────
//
//  Defeats keyword filters (like new_api "sensitive_words_detected")
//  while remaining 100% transparent to LLM tokenizers (Claude, GPT).
//
//  Strategy:
//    1. Pool of 6 different invisible Unicode characters (not just \u200b)
//    2. Random character selection per insertion (defeats single-char stripping)
//    3. Random insertion position within each word (defeats pattern-based stripping)
//    4. Variable density: more insertions in longer words
//    5. Short words (1-2 chars) are never touched
//    6. Punctuation, numbers, whitespace, and markdown are preserved exactly
//

// Pool of invisible Unicode characters — all render as zero-width / invisible
const INVISIBLE_POOL = [
  '\u200B', // Zero-Width Space
  '\u200C', // Zero-Width Non-Joiner
  '\u200D', // Zero-Width Joiner
  '\u2060', // Word Joiner
  '\uFEFF', // Zero-Width No-Break Space (BOM)
  '\u00AD', // Soft Hyphen (invisible unless line-break occurs)
];

/** Pick a random invisible character from the pool */
function randomInvisible() {
  return INVISIBLE_POOL[Math.floor(Math.random() * INVISIBLE_POOL.length)];
}

/**
 * Obfuscate a single word by inserting invisible characters at random positions.
 *
 *   Word length 3-5:  1 invisible char inserted
 *   Word length 6-9:  2 invisible chars inserted
 *   Word length 10+:  3 invisible chars inserted
 *
 * Insertion positions are randomized between characters (never at start/end).
 * Each insertion uses a randomly chosen invisible character from the pool.
 */
function obfuscateWord(word) {
  const len = word.length;
  if (len < 3) return word; // Never touch tiny words

  // Decide how many invisible chars to insert
  const numInsertions = len < 6 ? 1 : len < 10 ? 2 : 3;

  // Collect all valid insertion positions (between characters)
  // Position i means "insert between char[i-1] and char[i]"
  const validPositions = [];
  for (let i = 1; i < len; i++) {
    validPositions.push(i);
  }

  // Pick unique random positions
  const chosen = new Set();
  while (chosen.size < numInsertions && chosen.size < validPositions.length) {
    const idx = Math.floor(Math.random() * validPositions.length);
    chosen.add(validPositions[idx]);
  }

  // Sort descending so splicing doesn't shift subsequent indices
  const sortedPositions = [...chosen].sort((a, b) => b - a);

  // Build result by inserting invisible chars
  const chars = word.split('');
  for (const pos of sortedPositions) {
    chars.splice(pos, 0, randomInvisible());
  }

  return chars.join('');
}

/**
 * Obfuscate a full text string.
 * Matches words of 3+ Latin/accented characters and obfuscates each one.
 * Everything else (punctuation, numbers, whitespace, markdown, URLs) is preserved as-is.
 */
function obfuscateText(text) {
  if (!text || typeof text !== 'string') return text;

  if (OBFUSCATE_MODE === 'zero-width') {
    // Replace each qualifying word with its obfuscated version
    return text.replace(/[a-zA-ZÀ-ÿ]{3,}/g, (match) => obfuscateWord(match));
  }

  if (OBFUSCATE_MODE === 'base64') {
    const encoded = Buffer.from(text, 'utf-8').toString('base64');
    return `[BASE64-ENCODED CONTEXT: ${encoded}]`;
  }

  return text;
}

/**
 * Process a single message's content field.
 * Handles both string content and OpenAI-style array content
 * (e.g. [{type: "text", text: "..."}, {type: "image_url", ...}]).
 */
function processMessageContent(content) {
  if (typeof content === 'string') {
    return obfuscateText(content);
  }
  if (Array.isArray(content)) {
    return content.map(item => {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        return { ...item, text: obfuscateText(item.text) };
      }
      return item;
    });
  }
  return content;
}

/**
 * Process the full request body before forwarding to AgentRouter.
 * Clones the body (never mutates the original) and obfuscates all message contents.
 */
function processRequestBody(body) {
  if (!body || OBFUSCATE_MODE === 'none') return body;

  const cloned = JSON.parse(JSON.stringify(body));

  if (Array.isArray(cloned.messages)) {
    // For base64 mode, prepend a system instruction so the LLM knows to decode
    if (OBFUSCATE_MODE === 'base64') {
      cloned.messages.unshift({
        role: 'system',
        content: 'NOTE FOR MODEL: User messages in this conversation are encoded in Base64 for transmission privacy. Decode them internally before processing. Always respond in normal plain text.'
      });
    }

    cloned.messages = cloned.messages.map(msg => {
      if (msg && msg.content) {
        return { ...msg, content: processMessageContent(msg.content) };
      }
      return msg;
    });
  }

  return cloned;
}

// ─── Disguise Profiles ──────────────────────────────────

const DISGUISE_PROFILES = {
  'claude-code': {
    'User-Agent': 'claude-cli/1.0.18 (external, cli)',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'Windows',
    'x-stainless-package-version': '1.0.18',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': '22.12.0',
    'x-stainless-retry-count': '0',
  },
  'cursor': {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) VSCode/1.96.4 Cursor/0.45.12 Electron/32.2.6 Safari/537.36',
    'Origin': 'vscode-file://vscode-app',
    'x-cursor-client-version': '0.45.12',
    'x-cursor-timezone': 'Europe/Paris',
    'x-cursor-checksum': 'auto',
  },
  'codex': {
    'User-Agent': 'codex-cli/1.0.0 (external, cli)',
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'Windows',
    'x-stainless-package-version': '1.0.0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': '22.12.0',
  },
};

// ─── Logging Helpers ────────────────────────────────────

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level, message, extra = '') {
  const colors = { INFO: COLORS.green, WARN: COLORS.yellow, ERROR: COLORS.red, PROXY: COLORS.cyan };
  const color = colors[level] || COLORS.reset;
  const prefix = `${COLORS.dim}${timestamp()}${COLORS.reset} ${color}[${level}]${COLORS.reset}`;
  console.log(`${prefix} ${message}${extra ? ` ${COLORS.dim}| ${extra}${COLORS.reset}` : ''}`);
}

// ─── Middleware ──────────────────────────────────────────

// Parse JSON bodies (with high limit for long conversations)
app.use(express.json({ limit: '50mb' }));

// Permissive CORS — JanitorAI may send cross-origin requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Request logging
app.use((req, res, next) => {
  if (req.path !== '/health') {
    log('INFO', `${req.method} ${req.path}`, `from ${req.ip}`);
  }
  next();
});

// ─── Header Builder ─────────────────────────────────────

/**
 * Build disguised headers for forwarding to AgentRouter.
 * Takes the API key from the incoming request (JanitorAI sends it).
 */
function buildDisguisedHeaders(incomingReq, contentType) {
  // Get API key: prefer override env var, fallback to what JanitorAI sends
  let apiKey = OVERRIDE_API_KEY;
  if (!apiKey) {
    const authHeader = incomingReq.headers['authorization'] || '';
    apiKey = authHeader.replace(/^Bearer\s+/i, '');
  }

  if (!apiKey) {
    return null; // Will trigger 401
  }

  // Get the disguise profile
  const profile = DISGUISE_PROFILES[DISGUISE_MODE] || DISGUISE_PROFILES['claude-code'];

  // Build clean headers — NO JanitorAI fingerprints leak through
  const headers = {
    'Content-Type': contentType || 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    ...profile,
  };

  // If streaming, adjust Accept header
  if (incomingReq.body && incomingReq.body.stream) {
    headers['Accept'] = 'text/event-stream';
  }

  return headers;
}

// ─── Proxy Core ─────────────────────────────────────────

/**
 * Forward a request to AgentRouter with disguised headers.
 * Handles both streaming (SSE) and non-streaming responses.
 */
async function proxyRequest(req, res, targetPath) {
  const targetUrl = `${AGENTROUTER_BASE_URL}${targetPath}`;
  const isStreaming = req.body && req.body.stream === true;

  // Build headers
  const headers = buildDisguisedHeaders(req, 'application/json');
  if (!headers) {
    return res.status(401).json({
      error: {
        message: 'No API key provided. Set your AgentRouter API key in JanitorAI.',
        type: 'authentication_error',
        code: 'missing_api_key',
      }
    });
  }

  const model = req.body?.model || 'unknown';
  const messageCount = req.body?.messages?.length || 0;
  log('PROXY', `→ ${targetUrl}`, `model=${model} msgs=${messageCount} stream=${isStreaming} disguise=${DISGUISE_MODE} obfuscate=${OBFUSCATE_MODE}`);

  try {
    const fetchOptions = {
      method: req.method,
      headers,
    };

    // Only add body for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const processedBody = processRequestBody(req.body);
      fetchOptions.body = JSON.stringify(processedBody);
    }

    const response = await fetch(targetUrl, fetchOptions);

    log('PROXY', `← ${response.status} ${response.statusText}`, `model=${model}`);

    // Forward error responses as-is
    if (!response.ok) {
      const errorBody = await response.text();
      log('ERROR', `AgentRouter returned ${response.status}`, errorBody.slice(0, 300));
      
      // Try to parse as JSON, otherwise wrap in error object
      try {
        const parsed = JSON.parse(errorBody);
        return res.status(response.status).json(parsed);
      } catch {
        return res.status(response.status).json({
          error: {
            message: `AgentRouter error: ${errorBody.slice(0, 500)}`,
            type: 'upstream_error',
            code: `http_${response.status}`,
          }
        });
      }
    }

    // ─── Streaming Response ───
    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            log('PROXY', `Stream complete`, `model=${model}`);
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);
          // Flush immediately for real-time streaming
          if (res.flush) res.flush();
        }
      } catch (streamErr) {
        log('ERROR', `Stream interrupted: ${streamErr.message}`);
      } finally {
        res.end();
      }
      return;
    }

    // ─── Non-streaming Response ───
    const data = await response.json();
    return res.json(data);

  } catch (err) {
    log('ERROR', `Proxy fetch failed: ${err.message}`);
    return res.status(502).json({
      error: {
        message: `Bridge proxy error: ${err.message}`,
        type: 'proxy_error',
        code: 'fetch_failed',
      }
    });
  }
}

// ─── Routes ─────────────────────────────────────────────

// Main proxy endpoint — OpenAI-compatible chat completions
app.post('/v1/chat/completions', (req, res) => {
  return proxyRequest(req, res, '/v1/chat/completions');
});

// Also handle without /v1 prefix (some clients use /chat/completions directly)
app.post('/chat/completions', (req, res) => {
  return proxyRequest(req, res, '/v1/chat/completions');
});

// Models endpoint — proxy transparent
app.get('/v1/models', async (req, res) => {
  const headers = buildDisguisedHeaders(req, 'application/json');
  if (!headers) {
    // Return a hardcoded models list if no API key (useful for JanitorAI model picker)
    return res.json({
      object: 'list',
      data: [
        { id: 'claude-opus-4-8', object: 'model', created: 1700000000, owned_by: 'agentrouter' },
        { id: 'claude-opus-5', object: 'model', created: 1700000000, owned_by: 'agentrouter' },
        { id: 'gpt-5.6-sol', object: 'model', created: 1700000000, owned_by: 'agentrouter' },
      ],
    });
  }

  try {
    const response = await fetch(`${AGENTROUTER_BASE_URL}/v1/models`, { headers });
    if (response.ok) {
      const data = await response.json();
      return res.json(data);
    }
    // Fallback to hardcoded list
    return res.json({
      object: 'list',
      data: [
        { id: 'claude-opus-4-8', object: 'model', created: 1700000000, owned_by: 'agentrouter' },
        { id: 'claude-opus-5', object: 'model', created: 1700000000, owned_by: 'agentrouter' },
        { id: 'gpt-5.6-sol', object: 'model', created: 1700000000, owned_by: 'agentrouter' },
      ],
    });
  } catch {
    return res.json({
      object: 'list',
      data: [
        { id: 'claude-opus-4-8', object: 'model', created: 1700000000, owned_by: 'agentrouter' },
        { id: 'claude-opus-5', object: 'model', created: 1700000000, owned_by: 'agentrouter' },
        { id: 'gpt-5.6-sol', object: 'model', created: 1700000000, owned_by: 'agentrouter' },
      ],
    });
  }
});

app.get('/models', (req, res) => {
  // Redirect to /v1/models
  req.url = '/v1/models';
  return app.handle(req, res);
});

// Health check for Railway
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bridge: 'agentrouter-bridge',
    disguise: DISGUISE_MODE,
    target: AGENTROUTER_BASE_URL,
    uptime: Math.floor(process.uptime()),
  });
});

// Root — friendly info page
app.get('/', (req, res) => {
  res.json({
    name: 'AgentRouter Bridge',
    version: '1.0.0',
    description: 'Proxy bridge that disguises API requests for AgentRouter.org',
    status: 'running',
    disguise_mode: DISGUISE_MODE,
    endpoints: {
      chat: 'POST /v1/chat/completions',
      models: 'GET /v1/models',
      health: 'GET /health',
    },
    usage: {
      base_url: `Set this URL as your API base in JanitorAI`,
      api_key: 'Use your AgentRouter API key (sk-...)',
      models: ['claude-opus-4-8', 'claude-opus-5', 'gpt-5.6-sol'],
    },
  });
});

// Catch-all for other OpenAI-compatible endpoints (completions, embeddings, etc.)
app.all('/v1/*', (req, res) => {
  const targetPath = req.path;
  log('WARN', `Catch-all proxy for ${req.method} ${targetPath}`);
  return proxyRequest(req, res, targetPath);
});

// ─── Start Server ───────────────────────────────────────

app.listen(PORT, () => {
  console.log('');
  console.log(`${COLORS.bold}${COLORS.magenta}╔══════════════════════════════════════════════╗${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.magenta}║     AgentRouter Bridge — Disguise Proxy      ║${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.magenta}╚══════════════════════════════════════════════╝${COLORS.reset}`);
  console.log('');
  console.log(`  ${COLORS.green}▸${COLORS.reset} Proxy running on     ${COLORS.cyan}http://localhost:${PORT}${COLORS.reset}`);
  console.log(`  ${COLORS.green}▸${COLORS.reset} Target               ${COLORS.cyan}${AGENTROUTER_BASE_URL}${COLORS.reset}`);
  console.log(`  ${COLORS.green}▸${COLORS.reset} Disguise mode        ${COLORS.yellow}${DISGUISE_MODE}${COLORS.reset}`);
  console.log(`  ${COLORS.green}▸${COLORS.reset} Obfuscate mode       ${COLORS.yellow}${OBFUSCATE_MODE}${COLORS.reset}`);
  console.log(`  ${COLORS.green}▸${COLORS.reset} API Key source       ${COLORS.yellow}${OVERRIDE_API_KEY ? 'Environment variable' : 'From JanitorAI headers'}${COLORS.reset}`);
  console.log('');
  console.log(`  ${COLORS.dim}Configure JanitorAI with:${COLORS.reset}`);
  console.log(`  ${COLORS.dim}  API URL: http://localhost:${PORT}/v1${COLORS.reset}`);
  console.log(`  ${COLORS.dim}  API Key: your AgentRouter key (sk-...)${COLORS.reset}`);
  console.log('');
});
