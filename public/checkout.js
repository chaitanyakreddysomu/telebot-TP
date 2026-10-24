const token = decodeURIComponent(window.location.pathname.split('/').pop());
const fileInput = document.getElementById('proof');
const preview = document.getElementById('preview');
const dropzone = document.getElementById('dropzone');
const uploadPanel = document.getElementById('uploadPanel');
const message = document.getElementById('message');
const uploadButton = document.getElementById('upload');
const uploadButtonText = document.getElementById('uploadButtonText');
const extractedData = document.getElementById('extractedData');
const extractedFields = document.getElementById('extractedFields');
const ocrDebug = document.getElementById('ocrDebug');
const successScreen = document.getElementById('paymentSuccess');
const successInstruction = successScreen.querySelector('.success-instruction');
const maxFileSize = Number(fileInput.dataset.maxMb || 5) * 1024 * 1024;
let previewUrl = null;

function showError(text) {
  message.textContent = text;
  message.style.color = '#d99b9b';
}

function showReceipt(file) {
  if (!file) return;
  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    fileInput.value = '';
    showError('Choose a JPG, JPEG or PNG receipt image.');
    return;
  }
  if (file.size > maxFileSize) {
    fileInput.value = '';
    showError(`This image is too large. Maximum size is ${fileInput.dataset.maxMb} MB.`);
    return;
  }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  dropzone.classList.add('has-file');
  uploadPanel.classList.add('has-receipt');
  uploadButton.disabled = false;
  message.textContent = '';
}

function showPaymentSuccess(inviteSent = true) {
  if (inviteSent) {
    successInstruction.textContent = 'Your one-time channel invite link was sent in Telegram.';
  } else {
    successInstruction.textContent = 'Your payment is verified. Your channel invite is being prepared; do not pay again.';
  }
  successScreen.hidden = false;
  document.body.style.overflow = 'hidden';
}

fileInput.addEventListener('change', () => showReceipt(fileInput.files?.[0]));

['dragenter', 'dragover'].forEach(eventName => dropzone.addEventListener(eventName, event => {
  event.preventDefault();
  dropzone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach(eventName => dropzone.addEventListener(eventName, event => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
}));
dropzone.addEventListener('drop', event => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    showReceipt(file);
  } catch {
    showError('Could not read the dropped image. Please choose it from your device.');
  }
});

function showExtractedData(data = {}) {
  const values = [
    ['Payment status text', data.paymentStatus],
    ['Amount', data.amountPaise == null ? null : `₹${(Number(data.amountPaise) / 100).toFixed(2)}`],
    ['Transaction note', data.transactionNote],
    ['Paid to', data.payeeName],
    ['Payee UPI ID', data.payeeUpiId],
    ['Payer name', data.payerName],
    ['Payer bank', data.payerBank],
    ['Transaction date', data.transactionDate],
    ['Transaction ID / UTR', data.transactionId],
  ];
  extractedFields.replaceChildren();
  for (const [label, value] of values) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value || 'Not found in image';
    extractedFields.append(dt, dd);
  }
  const confidence = document.createElement('dt');
  const confidenceValue = document.createElement('dd');
  confidence.textContent = 'OCR confidence';
  confidenceValue.textContent = data.confidence == null ? 'Not provided' : `${Math.round(Number(data.confidence))}%`;
  extractedFields.append(confidence, confidenceValue);
  document.getElementById('recognizedText').textContent = data.recognizedText || 'No text could be read from the image.';
  document.getElementById('ocrDebugText').textContent = data.recognizedText || 'No text could be read from the image.';
  ocrDebug.hidden = false;
  extractedData.hidden = false;
}

function showValidationChecks(ocrMatch = {}) {
  const labels = {
    transactionNoteMatched: 'Transaction note matches this order',
    amountMatched: 'Amount matches this order',
    paymentSuccessTextFound: 'Success wording found in receipt',
    duplicateTransactionId: 'Transaction ID already used'
  };
  const list = document.getElementById('matchChecks');
  list.replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    if (!(key in (ocrMatch.checks || {}))) continue;
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = key === 'duplicateTransactionId'
      ? (ocrMatch.checks[key] ? 'Duplicate — rejected' : 'No duplicate found')
      : (ocrMatch.checks[key] ? 'Matched' : 'Not matched');
    list.append(dt, dd);
  }
}

uploadButton.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    message.textContent = 'Choose a receipt image first.';
    return;
  }

  const form = new FormData();
  form.append('proof', file);
  uploadButton.disabled = true;
  uploadButton.classList.add('loading');
  uploadButtonText.textContent = 'Checking payment…';
  message.textContent = 'Uploading and reading receipt…';
  try {
    const response = await fetch(`/api/checkout/${encodeURIComponent(token)}/proof`, { method: 'POST', body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `Upload failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    message.textContent = result.message || 'Receipt uploaded for review.';
    document.getElementById('status').textContent = result.status;
    showExtractedData(result.extracted);
    showValidationChecks(result.ocrMatch);
    if (result.status === 'verified' || result.status === 'delivered') showPaymentSuccess(result.deliverySent !== false);
    console.log('[Payment proof upload] Success', { status: result.status, message: result.message });
    console.log('[Receipt OCR extracted fields]', result.extracted || {});
    console.log('[Receipt OCR amount diagnostics]', {
      amountPaise: result.extracted?.amountPaise ?? null,
      amountResolution: result.extracted?.amountResolution ?? null,
      ambiguousAmount: result.extracted?.ambiguousAmount ?? null,
      candidates: result.extracted?.amountCandidates ?? [],
    });
    console.log('[Receipt OCR full recognized text]\n' + (result.extracted?.recognizedText || 'No text could be read from the image.'));
    refreshStatus();
  } catch (error) {
    message.textContent = error.message || 'Upload failed. Please try again.';
    console.error('[Payment proof upload] Failed', { status: error.status || null, error: error.message || error });
  } finally {
    uploadButton.disabled = false;
    uploadButton.classList.remove('loading');
    uploadButtonText.textContent = 'Check payment';
  }
});

async function refreshStatus() {
  try {
    const response = await fetch(`/api/checkout/${encodeURIComponent(token)}/status`);
    if (!response.ok) return;
    const { status, testMode } = await response.json();
    document.getElementById('status').textContent = status;
    const statusMessage = document.getElementById('statusMessage');
    if (testMode) statusMessage.textContent = 'OCR test passed. This is not confirmed payment and cannot deliver access.';
    else if (status === 'delivered') {
      statusMessage.textContent = 'Payment verified. Your one-time channel invite link was sent in Telegram.';
      showPaymentSuccess(true);
    }
    else if (status === 'verified') {
      statusMessage.textContent = 'Payment verified. Your channel invite is being prepared.';
      showPaymentSuccess(false);
    }
    else if (status === 'under_review') statusMessage.textContent = 'Your receipt is awaiting review. Do not pay again.';
    else if (status === 'proof_submitted') statusMessage.textContent = 'Your receipt did not pass all checks. You can upload a corrected receipt; up to 3 attempts are allowed.';
    else if (status === 'rejected' || status === 'expired') statusMessage.textContent = 'This order cannot be completed. Please return to Telegram for help.';
  } catch {
    // Keep the last displayed status if the network is temporarily unavailable.
  }
}

window.setInterval(refreshStatus, 5000);
