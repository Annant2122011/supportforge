export type KnowledgeVisibility = 'public' | 'staff';
export type QuickReplyPlaceholder = 'user' | 'ticket_number' | 'department' | 'channel' | 'guild';

export const QUICK_REPLY_PLACEHOLDERS: readonly QuickReplyPlaceholder[] = [
  'user',
  'ticket_number',
  'department',
  'channel',
  'guild',
];

export function normalizeKnowledgeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function slugifyKnowledgeTitle(title: string): string {
  const slug = normalizeKnowledgeText(title)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || 'article';
}

export function normalizeKnowledgeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of tags) {
    const tag = raw.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 32);
    const key = tag.toLocaleLowerCase('en');
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    output.push(tag);
    if (output.length >= 20) break;
  }
  return output;
}

/** Bounded Levenshtein distance for typo-tolerant suggestions on small guild KBs. */
export function editDistance(left: string, right: string, maximum = 4): number {
  const a = [...left];
  const b = [...right];
  if (Math.abs(a.length - b.length) > maximum) return maximum + 1;
  if (a.length > b.length) return editDistance(right, left, maximum);

  let previous = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let row = 1; row <= b.length; row += 1) {
    const current = [row];
    let minimum = row;
    for (let column = 1; column <= a.length; column += 1) {
      const cost = a[column - 1] === b[row - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + cost,
      );
      minimum = Math.min(minimum, current[column]);
    }
    if (minimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[a.length] <= maximum ? previous[a.length] : maximum + 1;
}

export function fuzzyKnowledgeScore(
  query: string,
  fields: { title: string; category: string; tags: readonly string[]; body: string },
): number {
  const queryTokens = normalizeKnowledgeText(query).split(' ').filter((token) => token.length >= 3);
  if (!queryTokens.length) return 0;

  const weightedWords = [
    ...normalizeKnowledgeText(fields.title).split(' ').map((word) => ({ word, weight: 4 })),
    ...fields.tags.flatMap((tag) => normalizeKnowledgeText(tag).split(' ').map((word) => ({ word, weight: 2.5 }))),
    ...normalizeKnowledgeText(fields.category).split(' ').map((word) => ({ word, weight: 2 })),
    ...normalizeKnowledgeText(fields.body).split(' ').map((word) => ({ word, weight: 0.5 })),
  ];
  if (!weightedWords.length) return 0;

  let total = 0;
  let matched = 0;
  for (const token of queryTokens) {
    const maximumDistance = token.length >= 8 ? 2 : 1;
    let best = 0;
    for (const candidate of weightedWords) {
      if (candidate.word.length < 3) continue;
      if (candidate.word === token) {
        best = Math.max(best, candidate.weight);
        continue;
      }
      const distance = editDistance(token, candidate.word, maximumDistance);
      if (distance <= maximumDistance) {
        const quality = 1 - distance / Math.max(token.length, candidate.word.length);
        best = Math.max(best, candidate.weight * quality);
      }
    }
    total += best;
    if (best > 0) matched += 1;
  }
  return matched === 0 ? 0 : Number((total * (matched / queryTokens.length)).toFixed(4));
}

export interface QuickReplyContext {
  user: string;
  ticket_number: string;
  department: string;
  channel: string;
  guild: string;
}

export function validateQuickReplyTemplate(template: string): void {
  if (!template.trim()) throw new Error('Quick reply content cannot be empty.');
  if (template.length > 1900) throw new Error('Quick reply content must be 1,900 characters or fewer.');
  const allowed = new Set<string>(QUICK_REPLY_PLACEHOLDERS);
  const pattern = /\{([^{}]+)\}/g;
  for (const match of template.matchAll(pattern)) {
    const rawName = match[1].trim();
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) {
      throw new Error('Unsupported placeholder {' + rawName + '}. Supported placeholders: ' + QUICK_REPLY_PLACEHOLDERS.map((item) => '{' + item + '}').join(', ') + '.');
    }
  }
}

export function renderQuickReplyTemplate(
  template: string,
  context: QuickReplyContext,
): string {
  validateQuickReplyTemplate(template);
  return template.replace(/\{(user|ticket_number|department|channel|guild)\}/gi, (_full, key: string) => {
    const lookup = key.toLowerCase() as keyof QuickReplyContext;
    return String(context[lookup] ?? '').replace(/@/g, '@\u200b');
  });
}
