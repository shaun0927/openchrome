#!/usr/bin/env node
/**
 * Native Messaging Host for Claude Chrome Parallel
 *
 * This script acts as a bridge between Claude Code CLI and the Chrome extension.
 * It uses the Native Messaging protocol (32-bit length prefix + JSON).
 */

const net = require('net');
const crypto = require('crypto');

// Configuration
const EXTENSION_ID = process.env.CLAUDE_CHROME_PARALLEL_EXTENSION_ID || '';
const WEBSOCKET_PORT = 9222; // Chrome DevTools Protocol port

/**
 * Read a native message from stdin
 * Format: 4-byte little-endian length + JSON message
 */
function readMessage() {
  return new Promise((resolve, reject) => {
    // Read 4-byte length prefix
    const lengthBuffer = Buffer.alloc(4);
    let bytesRead = 0;

    const readLength = () => {
      const chunk = process.stdin.read(4 - bytesRead);
      if (chunk === null) {
        // No more data available, wait for more
        process.stdin.once('readable', readLength);
        return;
      }

      chunk.copy(lengthBuffer, bytesRead);
      bytesRead += chunk.length;

      if (bytesRead < 4) {
        process.stdin.once('readable', readLength);
        return;
      }

      const messageLength = lengthBuffer.readUInt32LE(0);

      if (messageLength === 0) {
        resolve(null);
        return;
      }

      if (messageLength > 1024 * 1024) {
        reject(new Error(`Message too large: ${messageLength} bytes`));
        return;
      }

      // Read message body
      const messageBuffer = Buffer.alloc(messageLength);
      let messageBytesRead = 0;

      const readBody = () => {
        const bodyChunk = process.stdin.read(messageLength - messageBytesRead);
        if (bodyChunk === null) {
          process.stdin.once('readable', readBody);
          return;
        }

        bodyChunk.copy(messageBuffer, messageBytesRead);
        messageBytesRead += bodyChunk.length;

        if (messageBytesRead < messageLength) {
          process.stdin.once('readable', readBody);
          return;
        }

        try {
          const message = JSON.parse(messageBuffer.toString('utf8'));
          resolve(message);
        } catch (e) {
          reject(new Error(`Invalid JSON: ${e.message}`));
        }
      };

      readBody();
    };

    readLength();
  });
}

/**
 * Write a native message to stdout
 * Format: 4-byte little-endian length + JSON message
 */
function writeMessage(message) {
  const messageJson = JSON.stringify(message);
  const messageBuffer = Buffer.from(messageJson, 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(messageBuffer.length, 0);

  process.stdout.write(lengthBuffer);
  process.stdout.write(messageBuffer);
}

/**
 * Send message to Chrome extension via Chrome DevTools Protocol
 */
async function sendToExtension(message) {
  // In a full implementation, this would:
  // 1. Connect to the Chrome extension via WebSocket or Native Messaging
  // 2. Send the MCP request
  // 3. Wait for and return the response

  // For now, we return a placeholder response
  // The actual implementation would use chrome.runtime.sendNativeMessage

  return {
    jsonrpc: '2.0',
    id: message.id,
    result: {
      content: [
        {
          type: 'text',
          text: 'Native host received message. Extension communication pending.',
        },
      ],
    },
  };
}

/**
 * Handle MCP initialize request
 */
function handleInitialize(request) {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'claude-chrome-parallel-native',
        version: '0.1.0',
      },
    },
  };
}

/**
 * Main message loop
 */
async function main() {
  // Set stdin to binary mode
  process.stdin.setEncoding(null);

  // Log startup
  console.error('[Native Host] Started');

  try {
    while (true) {
      const message = await readMessage();

      if (message === null) {
        // EOF
        break;
      }

      console.error('[Native Host] Received:', message.method || message.type);

      let response;

      if (message.method === 'initialize') {
        response = handleInitialize(message);
      } else {
        // Forward to extension
        response = await sendToExtension(message);
      }

      writeMessage(response);
    }
  } catch (error) {
    console.error('[Native Host] Error:', error.message);
    process.exit(1);
  }

  console.error('[Native Host] Shutting down');
}

// Handle process signals
process.on('SIGINT', () => {
  console.error('[Native Host] Received SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('[Native Host] Received SIGTERM');
  process.exit(0);
});

// Start
main();
