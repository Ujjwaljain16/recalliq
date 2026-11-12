/**
 * Generic technology and product categories. A category is something a user names to narrow a question
 * ("Postgres plans", "a CRM"), not a vendor to research, so it belongs in `topicTerms`, not in `entities`.
 *
 * This list is a conservative BACKSTOP behind the analysis prompt, not a complete list: a category that is not
 * here passes through as an entity, and the prompt is the primary defence. The rule is an EXACT match of the
 * normalised mention: "PostgreSQL Cloud Co" is not "postgresql" and stays an entity if the model returns it as
 * a named vendor. Names that are also real companies or products (MongoDB, Redis, Docker, Snowflake, ...) are
 * deliberately NOT listed.
 */
const GENERIC_CATEGORIES: readonly string[] = [
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'sqlite',
  'sql',
  'nosql',
  'database',
  'databases',
  'db',
  'vector database',
  'data warehouse',
  'data lake',
  'crm',
  'erp',
  'cms',
  'hosting',
  'web hosting',
  'cloud hosting',
  'cloud',
  'serverless',
  'api',
  'apis',
  'llm',
  'llms',
  'ai',
  'ml',
  'saas',
  'paas',
  'iaas',
  'kubernetes',
  'k8s',
  'cdn',
  'vpn',
  'devops',
  'ci cd',
  'monitoring',
  'observability',
  'analytics',
  'storage',
  'object storage',
  'email',
  'email marketing',
  'ecommerce',
  'e commerce',
  'helpdesk',
  'help desk',
  'project management',
  'accounting',
  'payments',
  'authentication',
  'search',
  'open source',
];

const SET = new Set(GENERIC_CATEGORIES);

/** Lower case, punctuation to single spaces ("E-Commerce" and "e commerce" are the same). */
export function normaliseMention(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim();
}

/** True when the whole normalised mention is one of the listed categories. Never a substring match. */
export function isGenericCategory(text: string): boolean {
  return SET.has(normaliseMention(text));
}
