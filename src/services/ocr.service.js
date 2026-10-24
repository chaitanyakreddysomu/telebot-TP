
import { env } from '../config/env.js';

const MAX_AMOUNT_PAISE = 100_000_000; // ₹10,00,000

function toPaise(wholeText, fractionText = '') {
  const whole = Number(String(wholeText).replaceAll(',', ''));
  const fraction = Number(String(fractionText || '').padEnd(2, '0'));

  if (!Number.isSafeInteger(whole) || whole < 0) return null;

  const paise = whole * 100 + fraction;

  return Number.isSafeInteger(paise) &&
    paise > 0 &&
    paise <= MAX_AMOUNT_PAISE
    ? paise
    : null;
}

function extractAmountCandidates(text) {
  const input = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[‐-‒–—]/g, '-');

  const candidates = [];

  function add(raw, paise, priority, kind, index) {
    if (paise == null) return;

    const start = Math.max(0, index - 50);
    const end = Math.min(input.length, index + raw.length + 50);

    candidates.push({
      paise,
      raw,
      priority,
      kind,
      context: input
        .slice(start, end)
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }

  // Priority 3: explicit currency-labelled amounts.
  const currencyRegex =
    /(?:₹|INR\b|Rs\.?\s*)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/gi;

  for (const match of input.matchAll(currencyRegex)) {
    add(
      match[0],
      toPaise(match[1], match[2] || ''),
      3,
      'currency',
      match.index
    );
  }

  // Priority 2: decimal amounts with payment-related context.
  // Priority 1: other decimal values, retained for diagnostics.
  const decimalRegex =
    /(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d)/g;

  for (const match of input.matchAll(decimalRegex)) {
    const context = input.slice(
      Math.max(0, match.index - 55),
      Math.min(input.length, match.index + match[0].length + 55)
    );

    const labelled =
      /\b(amount|paid|total|debited|sent|transfer|payment|received)\b/i
        .test(context);

    add(
      match[0],
      toPaise(match[1], match[2]),
      labelled ? 2 : 1,
      'decimal',
      match.index
    );
  }

  // Priority 2: whole-number amounts next to explicit amount labels.
  const labelledRegex =
    /\b(?:amount(?:\s+paid)?|total\s+paid|paid|debited|sent|transfer\s+amount)\s*[:\-]?\s*(?:₹|INR\b|Rs\.?\s*)?(\d{1,3}(?:,\d{3})+|\d{1,7})(?![\d.,])/gi;

  for (const match of input.matchAll(labelledRegex)) {
    add(
      match[0],
      toPaise(match[1]),
      2,
      'labelled_integer',
      match.index
    );
  }

  return candidates;
}

function resolveReceiptAmount(ocrPasses, expectedAmountPaise = null) {
  const candidates = ocrPasses.flatMap(pass =>
    extractAmountCandidates(pass.text).map(candidate => ({
      ...candidate,
      source: pass.source,
    }))
  );

  const validExpected =
    Number.isSafeInteger(expectedAmountPaise) &&
    expectedAmountPaise > 0 &&
    expectedAmountPaise <= MAX_AMOUNT_PAISE;

  // Resolve ambiguity only when OCR actually extracted the expected amount.
  if (validExpected) {
    const matching = candidates.filter(
      candidate => candidate.paise === expectedAmountPaise
    );

    if (matching.length > 0) {
      return {
        amountPaise: expectedAmountPaise,
        ambiguousAmount: false,
        amountCandidates: candidates,
        amountResolution: 'expected_amount_matched_ocr',
      };
    }
  }

  if (candidates.length === 0) {
    return {
      amountPaise: null,
      ambiguousAmount: true,
      amountCandidates: [],
      amountResolution: 'no_amount_found',
    };
  }

  const maxPriority = Math.max(
    ...candidates.map(candidate => candidate.priority)
  );

  const strongest = candidates.filter(
    candidate => candidate.priority === maxPriority
  );

  const values = [
    ...new Set(strongest.map(candidate => candidate.paise)),
  ];

  if (values.length !== 1) {
    return {
      amountPaise: null,
      ambiguousAmount: true,
      amountCandidates: candidates,
      amountResolution: 'conflicting_amounts',
    };
  }

  return {
    amountPaise: values[0],
    ambiguousAmount: false,
    amountCandidates: candidates,
    amountResolution: 'unique_strongest_candidate',
  };
}

function extractTransactionId(text) {
  return String(text || '').match(
    /(?:UTR|UPI\s*Ref(?:erence)?(?:\s*No)?|Transaction\s*ID|Txn\s*ID)\s*[:#-]?\s*([A-Z0-9]{8,24})/i
  )?.[1]?.toUpperCase() || null;
}

function extractTransactionNote(text) {
  return String(text || '').match(
    /\bPFM-[A-F0-9]{14}\b/i
  )?.[0]?.toUpperCase() || null;
}

function extractPayeeName(text) {
  const input = String(text || '');
  const bankingName = input.match(
    /\bBanking\s+Name\s*[:\-]?\s*([^\r\n]+)/i
  )?.[1] || '';

  if (bankingName) {
    const cleanBankingName = bankingName
      .split(/(?:[©®]|\bSent\s+to\b|\bTransfer\s+Details\b|(?:₹|INR|Rs\.?)\s*[\d,]+(?:\.\d{1,2})?)/i)[0]
      .replace(/[^\p{L}\p{N} .'-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleanBankingName) return cleanBankingName;
  }

  const line = input.match(
    /\b(?:paid\s+to|to)\s+([^\r\n]+)/i
  )?.[1] || '';

  return line
    .split(
      /(?:®|©|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|PFM-[A-Z0-9-]{8,}|(?:₹|INR|Rs\.?)\s*[\d,]+(?:\.\d{1,2})?|\b\d{1,7}\.\d{2}\b|\bBanking\s+Name\b|\bSent\s+to\b)/i
    )[0]
    .replace(/[\s|:;,.-]+$/g, '')
    .trim() || null;
}

function extractPayerName(text) {
  return String(text || '').match(
    /(?:paid\s+by|from|payer\s*name)\s*[:\-]?\s*([A-Z][A-Z .]{2,50})/i
  )?.[1]?.trim() || null;
}

function extractUpiIds(text) {
  return [...String(text || '').matchAll(
    /[A-Z0-9._-]{2,}@[A-Z0-9.-]{2,}/gi
  )].map(match => ({
    id: match[0],
    index: match.index,
  }));
}

function extractPayeeUpiId(text) {
  const input = String(text || '');
  const ids = extractUpiIds(input);
  const paidToMatch = /\bpaid\s+to\b/i.exec(input);
  const toMatch = /^\s*to\s+/im.exec(input);
  const recipientStart = paidToMatch?.index ?? toMatch?.index ?? -1;
  if (recipientStart < 0) return null;

  const afterRecipient = input.slice(recipientStart);
  const recipientEndMatch = /\b(?:Banking\s+Name|Sent\s+to|Transfer\s+Details|from|payer\s*name)\b/i.exec(afterRecipient);
  const recipientEnd = recipientEndMatch
    ? recipientStart + recipientEndMatch.index
    : input.length;

  return ids.find(item => item.index >= recipientStart && item.index < recipientEnd)?.id || null;
}

function extractPayerUpiId(text) {
  const input = String(text || '');
  const ids = extractUpiIds(input);
  const payerIndex = input.search(
    /(?:paid\s+by|from|payer\s*name)/i
  );
  const toIndex = input.search(/^\s*to\s+/im);

  return ids.find(item =>
    payerIndex >= 0 &&
    item.index > payerIndex &&
    (toIndex < 0 || item.index < toIndex)
  )?.id || null;
}

function extractPayerBank(text) {
  return String(text || '').match(
    /\b([A-Z][A-Z &.-]{1,40}Bank\s*[-–]\s*[A-Z0-9X*]{2,12})/i
  )?.[1]?.trim() || null;
}

function extractTransactionDate(text) {
  return String(text || '').match(
    /\b(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM))\b/i
  )?.[1] || null;
}

function hasPaymentSuccessText(text) {
  const input = String(text || '');

  const success = /\bsuccess(?:ful(?:ly)?)?\b/i.test(input);

  const failure =
    /\b(?:failed|declined|reversed|unsuccessful)\b|\bnot\s+success(?:ful)?\b/i
      .test(input);

  return success && !failure;
}

async function recognizeWithOcrSpaceEngine(buffer, mimeType, engine) {
  if (!['image/jpeg', 'image/png'].includes(mimeType)) {
    throw new Error('OCR.space supports JPEG or PNG receipts here. Please convert the image and upload it again.');
  }
  const form = new FormData();
  form.set('base64Image', `data:${mimeType};base64,${buffer.toString('base64')}`);
  form.set('language', 'eng');
  form.set('OCREngine', String(engine));
  form.set('isOverlayRequired', 'false');
  form.set('detectOrientation', 'true');
  form.set('isTable', 'true');
  form.set('scale', 'true');

  let response;
  try {
    response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { apikey: env.OCR_SPACE_API_KEY },
      signal: AbortSignal.timeout(30_000),
      body: form,
    });
  } catch {
    throw new Error('OCR.space request failed. Check network access and the OCR.space API key.');
  }

  const payload = await response.json().catch(() => ({}));
  const parsedResults = Array.isArray(payload.ParsedResults) ? payload.ParsedResults : [];
  const failedResult = parsedResults.find(result => Number(result.FileParseExitCode) !== 1);
  const apiError = payload.ErrorMessage || failedResult?.ErrorMessage || failedResult?.ErrorDetails;
  if (!response.ok || payload.IsErroredOnProcessing || apiError || parsedResults.length === 0) {
    const detail = Array.isArray(apiError) ? apiError.join('; ') : apiError;
    throw new Error(`OCR.space OCR failed: ${detail || `HTTP ${response.status || 'empty response'}`}`);
  }

  return {
    text: parsedResults
      .filter(result => Number(result.FileParseExitCode) === 1)
      .map(result => result.ParsedText || '')
      .filter(Boolean)
      .join('\n'),
    confidence: null,
  };
}

async function recognizeWithOcrSpace(buffer, mimeType, expectedAmountPaise) {
  let firstPass;
  let firstError;
  try {
    firstPass = await recognizeWithOcrSpaceEngine(buffer, mimeType, 2);
  } catch (error) {
    firstError = error;
  }

  const hasExpectedAmount = text => expectedAmountPaise != null &&
    extractAmountCandidates(text).some(candidate => candidate.paise === Number(expectedAmountPaise));
  const isComplete = text => /\bPFM-[A-F0-9]{14}\b/i.test(text) &&
    hasExpectedAmount(text) && hasPaymentSuccessText(text) &&
    /(?:UTR|UPI\s*Ref(?:erence)?(?:\s*No)?|Transaction\s*ID|Txn\s*ID)\s*[:#-]?\s*[A-Z0-9]{8,24}/i.test(text);

  if (firstPass && isComplete(firstPass.text)) return firstPass;

  let secondPass;
  try {
    secondPass = await recognizeWithOcrSpaceEngine(buffer, mimeType, 1);
  } catch (error) {
    if (!firstPass) throw firstError || error;
    return firstPass;
  }
  if (!firstPass) return secondPass;

  const score = text => Number(/\bPFM-[A-F0-9]{14}\b/i.test(text)) +
    Number(hasExpectedAmount(text)) + Number(hasPaymentSuccessText(text)) +
    Number(/(?:UTR|UPI\s*Ref(?:erence)?(?:\s*No)?|Transaction\s*ID|Txn\s*ID)\s*[:#-]?\s*[A-Z0-9]{8,24}/i.test(text));
  return score(secondPass.text) > score(firstPass.text) ? secondPass : firstPass;
}

export async function readReceipt(buffer, expectedAmountPaise = null, mimeType = 'image/jpeg') {
  const ocr = await recognizeWithOcrSpace(buffer, mimeType, expectedAmountPaise);
  const recognizedText = ocr.text || '';
  const amountResult = resolveReceiptAmount(
    [{ source: 'ocr_space', text: recognizedText }],
    expectedAmountPaise
  );

  return {
    text: recognizedText,
    paymentStatus: hasPaymentSuccessText(recognizedText)
      ? 'SUCCESS_TEXT_FOUND'
      : null,
    amountPaise: amountResult.amountPaise,
    amountCandidates: amountResult.amountCandidates,
    amountResolution: amountResult.amountResolution,
    ambiguousAmount: amountResult.ambiguousAmount,
    transactionNote: extractTransactionNote(recognizedText),
    transactionId: extractTransactionId(recognizedText),
    payeeName: extractPayeeName(recognizedText),
    payeeUpiId: extractPayeeUpiId(recognizedText),
    payerName: extractPayerName(recognizedText),
    payerUpiId: extractPayerUpiId(recognizedText),
    payerBank: extractPayerBank(recognizedText),
    transactionDate: extractTransactionDate(recognizedText),
    confidence: ocr.confidence,
  };
}
