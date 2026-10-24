import { supabase } from '../config/supabase.js';

export async function reviewReceipt(order, receipt, storagePath) {
  const normalize = value => String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleUpperCase('en-IN')
    .replace(/[^A-Z0-9]/g, '');

  const checks = {
    transactionNoteMatched: Boolean(
      receipt.transactionNote &&
      normalize(receipt.transactionNote) === normalize(order.transaction_note)
    ),
    amountMatched: receipt.amountPaise != null &&
      Number(receipt.amountPaise) === Number(order.amount_paise),
    paymentSuccessTextFound: Boolean(receipt.paymentStatus),
  };

  const { count: previousProofCount, error: countError } = await supabase
    .from('payment_proofs')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', order.id);
  if (countError) throw countError;
  const attempt = (previousProofCount || 0) + 1;
  const maxAttempts = 3;
  if (attempt > maxAttempts) {
    throw Object.assign(new Error('This order has used all 3 receipt upload attempts.'), { status: 409 });
  }

  const { data: proof, error: proofError } = await supabase.from('payment_proofs').insert({
    order_id: order.id,
    storage_path: storagePath,
    extracted_payment_status: receipt.paymentStatus,
    extracted_amount_paise: receipt.amountPaise,
    extracted_transaction_note: receipt.transactionNote,
    extracted_transaction_id: receipt.transactionId,
    ocr_text: receipt.text,
    extracted_payer_name: receipt.payerName || null,
    ocr_match_score: null,
    ocr_match_details: { ...checks, duplicateTransactionId: false, attempt, maxAttempts },
    ocr_status: 'needs_review',
    review_status: 'under_review',
  }).select('id').single();
  if (proofError) throw proofError;

  let duplicateTransactionId = false;
  if (receipt.transactionId) {
    const normalizedId = normalize(receipt.transactionId);
    const { data: existingReference, error: lookupError } = await supabase
      .from('payment_transaction_refs')
      .select('order_id')
      .eq('normalized_transaction_id', normalizedId)
      .maybeSingle();
    if (lookupError) throw lookupError;

    if (existingReference) {
      // Re-submitting the same receipt for this order is a retry, not cross-order reuse.
      duplicateTransactionId = existingReference.order_id !== order.id;
    } else {
      const { error: referenceError } = await supabase.from('payment_transaction_refs').insert({
        normalized_transaction_id: normalizedId,
        order_id: order.id,
        proof_id: proof.id,
      });
      if (referenceError?.code === '23505') {
        const { data: racedReference, error: racedLookupError } = await supabase
          .from('payment_transaction_refs')
          .select('order_id')
          .eq('normalized_transaction_id', normalizedId)
          .maybeSingle();
        if (racedLookupError) throw racedLookupError;
        duplicateTransactionId = racedReference?.order_id !== order.id;
      } else if (referenceError) throw referenceError;
    }
  }

  const passed = checks.transactionNoteMatched && checks.amountMatched &&
    checks.paymentSuccessTextFound && !duplicateTransactionId;
  const failedAttempt = !passed;
  const finalFailure = failedAttempt && attempt >= maxAttempts;
  const intendedStatus = passed ? 'verified' : finalFailure ? 'rejected' : 'proof_submitted';
  const verificationSource = 'ocr_rules';
  const now = new Date().toISOString();

  const { error: proofUpdateError } = await supabase.from('payment_proofs').update({
    ocr_status: passed ? 'completed' : 'flagged',
    review_status: duplicateTransactionId
      ? 'duplicate_transaction'
      : passed ? 'auto_verified' : finalFailure ? 'failed' : 'retry_allowed',
    ocr_match_details: { ...checks, duplicateTransactionId, attempt, maxAttempts },
  }).eq('id', proof.id);
  if (proofUpdateError) throw proofUpdateError;

  const { data: updatedOrder, error: orderError } = await supabase.from('payment_orders').update({
    status: intendedStatus,
    verification_source: verificationSource,
    verified_at: passed ? now : null,
    updated_at: now,
  }).eq('id', order.id).in('status', ['pending', 'proof_submitted', 'under_review'])
    .gt('expires_at', now).select('id').maybeSingle();
  if (orderError) throw orderError;

  return {
    status: updatedOrder ? intendedStatus : 'expired',
    passed: Boolean(updatedOrder && passed),
    attempt,
    remainingAttempts: Math.max(0, maxAttempts - attempt),
    checks: { ...checks, duplicateTransactionId },
  };
}
