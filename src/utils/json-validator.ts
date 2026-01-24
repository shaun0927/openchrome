/**
 * JSON validation and corruption detection utilities
 * Detects and attempts to recover from common JSON corruption patterns
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
  corrupted?: boolean;
  corruptionType?: 'concatenated' | 'truncated' | 'invalid' | 'empty';
}

export interface RecoveryResult {
  success: boolean;
  data?: unknown;
  method?: string;
  error?: string;
}

/**
 * Check if a string is valid JSON
 */
export function isValidJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect corruption in JSON content
 * Identifies common corruption patterns from race conditions
 */
export function detectCorruption(content: string): ValidationResult {
  if (!content || content.trim() === '') {
    return {
      valid: false,
      corrupted: true,
      corruptionType: 'empty',
      error: 'Empty content',
    };
  }

  // Check for concatenated JSON objects (common race condition pattern)
  // Pattern: }{  indicates two JSON objects were written together
  if (content.includes('}{')) {
    return {
      valid: false,
      corrupted: true,
      corruptionType: 'concatenated',
      error: 'Detected concatenated JSON objects (race condition corruption)',
    };
  }

  // Check for multiple JSON arrays concatenated
  if (content.includes('][')) {
    return {
      valid: false,
      corrupted: true,
      corruptionType: 'concatenated',
      error: 'Detected concatenated JSON arrays',
    };
  }

  // Try to parse
  try {
    JSON.parse(content);
    return { valid: true };
  } catch (error) {
    const errorMessage = (error as Error).message;

    // Detect truncated JSON
    if (
      errorMessage.includes('Unexpected end of JSON') ||
      errorMessage.includes('Unexpected end of input')
    ) {
      return {
        valid: false,
        corrupted: true,
        corruptionType: 'truncated',
        error: 'JSON appears to be truncated',
      };
    }

    return {
      valid: false,
      corrupted: true,
      corruptionType: 'invalid',
      error: `Invalid JSON: ${errorMessage}`,
    };
  }
}

/**
 * Extract valid JSON from corrupted content
 * Attempts various recovery strategies
 */
export function extractValidJson(content: string): RecoveryResult {
  // Strategy 1: Content is already valid
  if (isValidJson(content)) {
    return {
      success: true,
      data: JSON.parse(content),
      method: 'content_already_valid',
    };
  }

  const trimmed = content.trim();

  // Strategy 2: Handle concatenated JSON objects
  // Take the first complete JSON object
  if (trimmed.includes('}{')) {
    const firstObjectEnd = findMatchingBrace(trimmed, 0);
    if (firstObjectEnd !== -1) {
      const firstObject = trimmed.substring(0, firstObjectEnd + 1);
      if (isValidJson(firstObject)) {
        return {
          success: true,
          data: JSON.parse(firstObject),
          method: 'extract_first_object',
        };
      }
    }

    // Alternative: try to take the second object (might be more recent)
    const secondStart = trimmed.indexOf('}{') + 1;
    const secondObject = trimmed.substring(secondStart);
    if (isValidJson(secondObject)) {
      return {
        success: true,
        data: JSON.parse(secondObject),
        method: 'extract_second_object',
      };
    }
  }

  // Strategy 3: Handle truncated JSON
  // Try to complete the JSON by adding missing brackets
  const result = attemptTruncatedRecovery(trimmed);
  if (result.success) {
    return result;
  }

  // Strategy 4: Look for the largest valid JSON substring
  const largestValid = findLargestValidJson(trimmed);
  if (largestValid) {
    return {
      success: true,
      data: JSON.parse(largestValid),
      method: 'largest_valid_substring',
    };
  }

  return {
    success: false,
    error: 'Could not recover valid JSON from content',
  };
}

/**
 * Find the index of the matching closing brace for an opening brace
 */
function findMatchingBrace(content: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < content.length; i++) {
    const char = content[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Attempt to recover truncated JSON
 */
function attemptTruncatedRecovery(content: string): RecoveryResult {
  // Count open brackets and braces
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escapeNext = false;

  for (const char of content) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    switch (char) {
      case '{':
        openBraces++;
        break;
      case '}':
        openBraces--;
        break;
      case '[':
        openBrackets++;
        break;
      case ']':
        openBrackets--;
        break;
    }
  }

  // If we're inside a string, try to close it
  if (inString) {
    content += '"';
  }

  // Try to complete with missing brackets/braces
  const closing =
    ']'.repeat(Math.max(0, openBrackets)) +
    '}'.repeat(Math.max(0, openBraces));

  if (closing) {
    const completed = content + closing;
    if (isValidJson(completed)) {
      return {
        success: true,
        data: JSON.parse(completed),
        method: 'complete_truncated',
      };
    }
  }

  return { success: false, error: 'Truncated recovery failed' };
}

/**
 * Find the largest valid JSON substring
 */
function findLargestValidJson(content: string): string | null {
  // Start from the beginning, try to find complete JSON objects
  for (let end = content.length; end > 1; end--) {
    const substring = content.substring(0, end);
    if (isValidJson(substring)) {
      return substring;
    }
  }

  return null;
}

/**
 * Merge two JSON objects, preferring values from the second
 * Useful for recovering from partial writes
 */
export function mergeJsonObjects(
  obj1: Record<string, unknown>,
  obj2: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...obj1 };

  for (const [key, value] of Object.entries(obj2)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      // Recursively merge objects
      result[key] = mergeJsonObjects(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Validate .claude.json specific structure
 */
export function validateClaudeConfig(content: unknown): ValidationResult {
  if (typeof content !== 'object' || content === null) {
    return {
      valid: false,
      error: 'Config must be an object',
    };
  }

  const config = content as Record<string, unknown>;

  // Check for expected top-level keys (optional validation)
  const expectedKeys = [
    'numStartups',
    'tipsHistory',
    'userID',
    'firstStartTime',
  ];
  const hasExpectedKeys = expectedKeys.some((key) => key in config);

  if (!hasExpectedKeys && Object.keys(config).length > 0) {
    return {
      valid: false,
      error: 'Config missing expected Claude configuration keys',
    };
  }

  return { valid: true };
}
