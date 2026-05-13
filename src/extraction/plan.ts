import type { SchemaProperty } from './schema-validator';

export interface ExtractionFieldPlan {
  field: string;
  normalizedField: string;
  aliases: string[];
  selectorTokens: string[];
  expectedType?: string | string[];
  descriptionTokens: string[];
  enumValues?: unknown[];
  defaultValue?: unknown;
}

export interface ExtractionPlan {
  fields: ExtractionFieldPlan[];
  strategyOrder: ['json-ld', 'microdata', 'opengraph', 'css-heuristic'];
}

const MAX_ALIASES_PER_FIELD = 8;
const MAX_DESCRIPTION_TOKENS = 6;
const MAX_SELECTOR_TOKEN_LENGTH = 80;
const SAFE_SELECTOR_TOKEN = /^[a-zA-Z0-9_-]+$/;
const WORD_SPLIT = /[\s_-]+|(?=[A-Z])/g;

const BUILTIN_ALIASES: Record<string, string[]> = {
  title: ['title', 'name', 'headline'],
  headline: ['headline', 'title', 'name'],
  name: ['name', 'title', 'headline'],
  price: ['price', 'amount', 'salePrice', 'currentPrice', 'lowPrice', 'highPrice'],
  saleprice: ['salePrice', 'sale-price', 'sale_price', 'price', 'amount', 'currentPrice', 'lowPrice'],
  currentprice: ['currentPrice', 'current-price', 'current_price', 'price', 'amount', 'salePrice'],
  amount: ['amount', 'price', 'salePrice'],
  image: ['image', 'imageUrl', 'image_url', 'thumbnail', 'thumbnailUrl'],
  imageurl: ['imageUrl', 'image_url', 'image', 'thumbnailUrl', 'thumbnail'],
  thumbnail: ['thumbnail', 'thumbnailUrl', 'image', 'imageUrl'],
  thumbnailurl: ['thumbnailUrl', 'thumbnail_url', 'thumbnail', 'image', 'imageUrl'],
  publisheddate: ['publishedDate', 'published_date', 'publishedAt', 'datePublished', 'dateCreated', 'date'],
  publishedat: ['publishedAt', 'published_at', 'publishedDate', 'datePublished', 'date'],
  date: ['date', 'publishedDate', 'datePublished', 'dateCreated', 'dateModified'],
  url: ['url', 'href', 'link', 'canonical'],
  link: ['link', 'url', 'href'],
  rating: ['rating', 'ratingValue', 'aggregateRating', 'score'],
  reviewcount: ['reviewCount', 'review_count', 'ratingCount', 'reviews'],
  currency: ['currency', 'priceCurrency'],
  author: ['author', 'creator', 'byline'],
  brand: ['brand', 'manufacturer', 'maker'],
  sku: ['sku', 'productId', 'product_id'],
  category: ['category', 'section'],
  availability: ['availability', 'stock', 'inStock'],
  description: ['description', 'summary', 'snippet'],
  summary: ['summary', 'description', 'snippet'],
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'from',
  'current', 'main', 'primary', 'value', 'field', 'product', 'article', 'page',
]);

export function buildExtractionPlan(schemaProps: Record<string, SchemaProperty>): ExtractionPlan {
  return {
    fields: Object.entries(schemaProps).map(([field, prop]) => buildFieldPlan(field, prop)),
    strategyOrder: ['json-ld', 'microdata', 'opengraph', 'css-heuristic'],
  };
}

export function buildFieldPlan(field: string, prop: SchemaProperty = {}): ExtractionFieldPlan {
  const normalizedField = normalizeKey(field);
  const aliases = unique([
    field,
    ...caseVariants(field),
    ...(BUILTIN_ALIASES[normalizedField] || []),
  ])
    .filter(isSafeSelectorToken)
    .slice(0, MAX_ALIASES_PER_FIELD);

  const descriptionTokens = tokenizeDescription(prop.description)
    .filter(isSafeSelectorToken)
    .slice(0, MAX_DESCRIPTION_TOKENS);

  const selectorTokens = unique([...aliases, ...descriptionTokens])
    .filter(isSafeSelectorToken)
    .slice(0, MAX_ALIASES_PER_FIELD + MAX_DESCRIPTION_TOKENS);

  return {
    field,
    normalizedField,
    aliases,
    selectorTokens,
    expectedType: prop.type,
    descriptionTokens,
    enumValues: prop.enum,
    defaultValue: prop.default,
  };
}

export function isSafeSelectorToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SELECTOR_TOKEN_LENGTH && SAFE_SELECTOR_TOKEN.test(value);
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function caseVariants(value: string): string[] {
  const words = value.split(WORD_SPLIT).map(w => w.trim()).filter(Boolean);
  const lowerWords = words.map(w => w.toLowerCase());
  const kebab = lowerWords.join('-');
  const snake = lowerWords.join('_');
  const compact = lowerWords.join('');
  const camel = lowerWords.length === 0
    ? value
    : lowerWords[0] + lowerWords.slice(1).map(capitalize).join('');
  return [kebab, snake, compact, camel];
}

function tokenizeDescription(description: string | undefined): string[] {
  if (!description) return [];
  return description
    .split(/[^a-zA-Z0-9_-]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3)
    .filter(token => !STOPWORDS.has(token.toLowerCase()));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
