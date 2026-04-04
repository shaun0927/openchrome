/**
 * 2FA Detection Engine - Detects and classifies 2FA challenges on web pages
 */

export enum TwoFAType {
  TOTP = 'totp',
  SMS = 'sms',
  EMAIL = 'email',
  PUSH = 'push',
  RECOVERY = 'recovery',
  UNKNOWN = 'unknown',
}

export interface TwoFADetectionResult {
  detected: boolean;
  type: TwoFAType;
  confidence: number;      // 0-1
  inputSelector?: string;  // CSS selector for the input field
  submitSelector?: string; // CSS selector for submit button
  hints: string[];         // Human-readable hints about what was detected
}

/** Signals gathered from the page DOM for classification */
interface PageSignals {
  pageText: string;
  inputSelector?: string;
  inputAttributes?: Record<string, string>;
  submitSelector?: string;
}

/**
 * Classify 2FA type from page text and optional input attributes.
 * Priority: TOTP > SMS > Email > Push > Recovery > Unknown
 */
export function classifyTwoFAType(
  pageText: string,
  inputAttributes?: Record<string, string>,
): TwoFAType {
  const text = pageText.toLowerCase();

  // TOTP indicators (highest priority)
  const totpTextIndicators = [
    'authenticator',
    'verification code',
    '6-digit code',
    'two-factor',
    '2fa',
    'totp',
    'enter code from your',
  ];
  const hasTotpText = totpTextIndicators.some((indicator) => text.includes(indicator));
  const hasSixDigitInput =
    inputAttributes &&
    (inputAttributes.maxlength === '6' ||
      inputAttributes.pattern === '[0-9]{6}' ||
      (inputAttributes.type === 'number' && inputAttributes.maxlength === '6'));

  if (hasTotpText && hasSixDigitInput) {
    return TwoFAType.TOTP;
  }
  if (hasTotpText) {
    return TwoFAType.TOTP;
  }

  // SMS indicators
  const smsTextIndicators = [
    'text message',
    'sms',
    'sent to your phone',
    'phone number',
    'mobile',
  ];
  const hasSmsText = smsTextIndicators.some((indicator) => text.includes(indicator));
  // Phone number masking pattern: ***-***-1234
  const hasMaskedPhone = /\*+[-.\s]?\*+[-.\s]?\d{4}/.test(pageText);

  if (hasSmsText || hasMaskedPhone) {
    return TwoFAType.SMS;
  }

  // Email indicators
  const emailTextIndicators = [
    'check your email',
    'email verification',
    'sent to your email',
    'verify your email',
  ];
  const hasEmailText = emailTextIndicators.some((indicator) => text.includes(indicator));
  // Email masking pattern: j***@gmail.com
  const hasMaskedEmail = /[a-z]\*+@[a-z]+\.[a-z]+/.test(pageText.toLowerCase());

  if (hasEmailText || hasMaskedEmail) {
    return TwoFAType.EMAIL;
  }

  // Push indicators
  const pushTextIndicators = [
    'approve on your device',
    'push notification',
    'open your app to approve',
    'check your phone',
    'tap approve',
  ];
  const hasPushText = pushTextIndicators.some((indicator) => text.includes(indicator));

  if (hasPushText) {
    return TwoFAType.PUSH;
  }

  // Recovery code indicators
  const recoveryTextIndicators = [
    'backup code',
    'recovery code',
    'use a recovery code',
  ];
  const hasRecoveryText = recoveryTextIndicators.some((indicator) => text.includes(indicator));

  if (hasRecoveryText) {
    return TwoFAType.RECOVERY;
  }

  return TwoFAType.UNKNOWN;
}

/**
 * Compute confidence score for a 2FA detection result based on signals.
 */
function computeConfidence(
  type: TwoFAType,
  signals: PageSignals,
): number {
  if (type === TwoFAType.UNKNOWN) {
    return 0;
  }

  let score = 0.3; // base score for non-unknown type

  const text = signals.pageText.toLowerCase();

  if (type === TwoFAType.TOTP) {
    if (text.includes('authenticator')) score += 0.4;
    if (signals.inputAttributes?.maxlength === '6') score += 0.3;
    if (text.includes('6-digit')) score += 0.1;
    if (text.includes('two-factor') || text.includes('2fa')) score += 0.1;
  } else if (type === TwoFAType.SMS) {
    if (text.includes('sms') || text.includes('text message')) score += 0.3;
    if (/\*+[-.\s]?\*+[-.\s]?\d{4}/.test(signals.pageText)) score += 0.3;
    if (signals.inputAttributes?.maxlength === '6') score += 0.1;
  } else if (type === TwoFAType.EMAIL) {
    if (text.includes('check your email')) score += 0.3;
    if (/[a-z]\*+@[a-z]+\.[a-z]+/.test(signals.pageText.toLowerCase())) score += 0.3;
    if (signals.inputAttributes) score += 0.1;
  } else if (type === TwoFAType.PUSH) {
    if (text.includes('approve on your device')) score += 0.4;
    if (text.includes('push notification')) score += 0.2;
    if (!signals.inputSelector) score += 0.1; // push typically has no input
  } else if (type === TwoFAType.RECOVERY) {
    if (text.includes('backup code') || text.includes('recovery code')) score += 0.4;
    if (signals.inputAttributes) score += 0.1;
  }

  return Math.min(1, score);
}

/**
 * Build human-readable hints from signals and detected type.
 */
function buildHints(type: TwoFAType, signals: PageSignals): string[] {
  const hints: string[] = [];

  switch (type) {
    case TwoFAType.TOTP:
      hints.push('TOTP authenticator code required');
      if (signals.inputAttributes?.maxlength === '6') {
        hints.push('6-digit input field detected');
      }
      if (signals.inputSelector) {
        hints.push(`Input field: ${signals.inputSelector}`);
      }
      break;
    case TwoFAType.SMS:
      hints.push('SMS verification code required');
      {
        const phoneMatch = signals.pageText.match(/\*+[-.\s]?\*+[-.\s]?\d{4}/);
        if (phoneMatch) hints.push(`Phone pattern detected: ${phoneMatch[0]}`);
      }
      break;
    case TwoFAType.EMAIL:
      hints.push('Email verification code required');
      {
        const emailMatch = signals.pageText.toLowerCase().match(/[a-z]\*+@[a-z]+\.[a-z]+/);
        if (emailMatch) hints.push(`Email pattern detected: ${emailMatch[0]}`);
      }
      break;
    case TwoFAType.PUSH:
      hints.push('Push notification approval required — check your device');
      if (!signals.inputSelector) {
        hints.push('No input field detected (push approval only)');
      }
      break;
    case TwoFAType.RECOVERY:
      hints.push('Recovery/backup code required');
      break;
    case TwoFAType.UNKNOWN:
      hints.push('2FA page detected but type could not be classified');
      break;
  }

  return hints;
}

/**
 * Detect whether the current page presents a 2FA challenge.
 * Runs detection logic inside the page via page.evaluate().
 */
export async function detectTwoFA(page: any): Promise<TwoFADetectionResult> {
  let signals: PageSignals;

  try {
    signals = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';

      // Find candidate input fields for 2FA codes
      let inputSelector: string | undefined;
      let inputAttributes: Record<string, string> | undefined;

      // Look for numeric/text inputs that could be 2FA code fields
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="number"], input[type="tel"], input'),
      );

      for (const input of inputs) {
        const maxlength = input.getAttribute('maxlength');
        const pattern = input.getAttribute('pattern');
        const autocomplete = input.getAttribute('autocomplete');
        const name = input.getAttribute('name') || '';
        const id = input.getAttribute('id') || '';
        const placeholder = input.getAttribute('placeholder') || '';

        // Skip hidden/password inputs
        if (input.type === 'hidden' || input.type === 'password' || input.type === 'email') {
          continue;
        }

        // High-signal: OTP autocomplete, or 6-digit maxlength, or OTP-named field
        const isOtpInput =
          autocomplete === 'one-time-code' ||
          maxlength === '6' ||
          /otp|2fa|token|code|pin/i.test(name) ||
          /otp|2fa|token|code|pin/i.test(id) ||
          /otp|2fa|token|code|pin/i.test(placeholder) ||
          pattern === '[0-9]{6}';

        if (isOtpInput) {
          // Build a reliable CSS selector
          if (id) {
            inputSelector = `#${CSS.escape(id)}`;
          } else if (name) {
            inputSelector = `input[name="${CSS.escape(name)}"]`;
          } else {
            inputSelector = 'input[maxlength="6"]';
          }

          inputAttributes = {
            type: input.type || 'text',
            maxlength: maxlength || '',
            pattern: pattern || '',
            autocomplete: autocomplete || '',
            name,
            id,
            placeholder,
          };
          break;
        }
      }

      // Find submit button
      let submitSelector: string | undefined;
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button[type="submit"], input[type="submit"], button',
        ),
      );
      for (const btn of buttons) {
        const inputVal = (btn as HTMLInputElement).value;
        const btnText = (btn.innerText || (inputVal ? inputVal : '') || '').toLowerCase();
        if (
          btnText.includes('verify') ||
          btnText.includes('submit') ||
          btnText.includes('confirm') ||
          btnText.includes('continue') ||
          btnText.includes('next')
        ) {
          const btnId = btn.getAttribute('id');
          const btnType = btn.getAttribute('type');
          submitSelector = btnId
            ? `#${CSS.escape(btnId)}`
            : btnType === 'submit'
              ? 'button[type="submit"]'
              : 'button';
          break;
        }
      }

      return { pageText: bodyText, inputSelector, inputAttributes, submitSelector };
    });
  } catch (err) {
    console.error('[twofa-detector] page.evaluate failed:', err instanceof Error ? err.message : err);
    return {
      detected: false,
      type: TwoFAType.UNKNOWN,
      confidence: 0,
      hints: ['Detection failed: could not access page content'],
    };
  }

  const type = classifyTwoFAType(signals.pageText, signals.inputAttributes);

  // Not detected if type is unknown and no input selector found
  if (type === TwoFAType.UNKNOWN && !signals.inputSelector) {
    return {
      detected: false,
      type: TwoFAType.UNKNOWN,
      confidence: 0,
      hints: [],
    };
  }

  const confidence = computeConfidence(type, signals);
  const hints = buildHints(type, signals);

  return {
    detected: type !== TwoFAType.UNKNOWN || confidence > 0,
    type,
    confidence,
    inputSelector: signals.inputSelector,
    submitSelector: signals.submitSelector,
    hints,
  };
}
