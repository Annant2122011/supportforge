export type CsatSentiment = 'positive' | 'neutral' | 'negative';

export interface NormalizedCsatResponse {
  rating: number;
  comment: string;
}

export function normalizeCsatResponse(rating: number, comment: unknown = ''): NormalizedCsatResponse {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('Rating must be a whole number from 1 to 5.');
  }
  if (typeof comment !== 'string') {
    throw new Error('Feedback comment must be text.');
  }
  const normalizedComment = comment.trim();
  if (normalizedComment.length > 500) {
    throw new Error('Feedback comments must be 500 characters or fewer.');
  }
  return { rating, comment: normalizedComment };
}

export function categorizeCsatRating(rating: number): CsatSentiment {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('Rating must be a whole number from 1 to 5.');
  }
  return rating >= 4 ? 'positive' : rating === 3 ? 'neutral' : 'negative';
}
