export type CsatSurveyStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'responded'
  | 'expired'
  | 'cancelled'
  | 'failed';

const CSAT_SURVEY_TRANSITIONS: Record<CsatSurveyStatus, readonly CsatSurveyStatus[]> = {
  pending: ['sending', 'expired', 'cancelled'],
  sending: ['sent', 'failed', 'pending', 'expired', 'cancelled'],
  sent: ['responded', 'expired', 'cancelled'],
  responded: [],
  expired: [],
  cancelled: [],
  failed: ['sending', 'expired', 'cancelled'],
};

export const CSAT_SURVEY_MAX_DELIVERY_ATTEMPTS = 8;
export const CSAT_SURVEY_PROCESSING_LEASE_MS = 10 * 60_000;
export const CSAT_SURVEY_COMMENT_WINDOW_MS = 15 * 60_000;

export type CsatSurveyErrorTranslationKey =
  | 'csat.survey.error.notFound'
  | 'csat.survey.error.ownerOnly'
  | 'csat.survey.error.ticketNotClosed'
  | 'csat.survey.error.expired'
  | 'csat.survey.error.notAccepting'
  | 'csat.survey.error.invalidRating'
  | 'csat.survey.error.commentType'
  | 'csat.survey.error.commentTooLong'
  | 'csat.survey.error.commentEmpty'
  | 'csat.survey.error.commentUnavailable'
  | 'csat.survey.error.generic';

/** Map known domain failures to localized copy without ever returning raw infrastructure errors. */
export function getCsatSurveyErrorTranslationKey(message: string): CsatSurveyErrorTranslationKey {
  const keys: Record<string, CsatSurveyErrorTranslationKey> = {
    'This feedback survey was not found or is no longer available.': 'csat.survey.error.notFound',
    'Only the ticket creator can submit this feedback.': 'csat.survey.error.ownerOnly',
    'This ticket is no longer closed. The feedback survey has been cancelled.': 'csat.survey.error.ticketNotClosed',
    'This feedback survey has expired.': 'csat.survey.error.expired',
    'This survey is not currently accepting a response.': 'csat.survey.error.notAccepting',
    'Rating must be a whole number from 1 to 5.': 'csat.survey.error.invalidRating',
    'Feedback comment must be text.': 'csat.survey.error.commentType',
    'Feedback comments must be 500 characters or fewer.': 'csat.survey.error.commentTooLong',
    'Enter a comment or cancel the optional comment form.': 'csat.survey.error.commentEmpty',
    'The optional comment window has expired or a comment was already saved.': 'csat.survey.error.commentUnavailable',
  };
  return keys[message] ?? 'csat.survey.error.generic';
}

export function canTransitionCsatSurvey(
  from: CsatSurveyStatus,
  to: CsatSurveyStatus,
): boolean {
  return CSAT_SURVEY_TRANSITIONS[from].includes(to);
}

export function assertCsatSurveyTransition(
  from: CsatSurveyStatus,
  to: CsatSurveyStatus,
): void {
  if (!canTransitionCsatSurvey(from, to)) {
    throw new Error('Invalid CSAT survey transition: ' + from + ' -> ' + to + '.');
  }
}

export function calculateCsatSurveyRetryDelayMs(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('CSAT delivery attempt count must be a positive whole number.');
  }
  return Math.min(30_000 * 2 ** Math.min(attempts - 1, 10), 6 * 60 * 60_000);
}

export function isCsatSurveyExpired(expiresAt: string | Date, now: Date = new Date()): boolean {
  const expires = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(expires)) throw new Error('CSAT survey expiry must be a valid timestamp.');
  return expires <= now.getTime();
}

export function validateCsatSurveyTiming(delayMinutes: number, expiryDays: number): void {
  if (!Number.isInteger(delayMinutes) || delayMinutes < 0 || delayMinutes > 10080) {
    throw new Error('Survey delay must be a whole number from 0 to 10,080 minutes.');
  }
  if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 30) {
    throw new Error('Survey expiry must be a whole number from 1 to 30 days.');
  }
  if (delayMinutes >= expiryDays * 24 * 60) {
    throw new Error('Survey delay must be shorter than the survey expiry window.');
  }
}
