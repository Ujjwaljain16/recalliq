import type { Db } from '../db/index.js';
import { ConversationRepository } from '../db/repositories/conversations.js';
import { normalizeTerm, parseEnrichment, writeEnrichment } from '../db/repositories/enrichment.js';
import { MessageRepository } from '../db/repositories/messages.js';
import type { PersistedSentence } from '../shared/answer.js';
import type { IanaTz, Ms, UserId } from '../shared/ids.js';
import type { Clock } from '../shared/infrastructure.js';
import {
  addDays,
  firstInstantOnOrAfter,
  isoWeekday,
  localCivil,
  type Civil,
} from '../temporal/resolver.js';
import { EntityDirectory } from './live/entities.js';

/**
 * Example history for a reviewer who starts with an empty database. The challenge questions refer to earlier
 * conversations ("On Monday we shortlisted 5 CRM tools", "Last Tuesday I asked about Postgres hosting", "What
 * did I ask you on 3 November?"); with no history they can only get a cold-start reply.
 *
 * This writes those three earlier conversations for the current user, dated relative to today in the user's
 * time zone: last Monday, last Tuesday and the most recent 3 November. Each is titled "Example: ..." so it is
 * never mistaken for real history, and each holds the user's message and a short reply that states no price or
 * fact, so nothing the agent later checks was invented here. The messages are indexed and the shortlist stored
 * exactly as a real turn would store them (same repositories, same enrichment writer), so recall, routing and
 * research treat them like any other history. Running it twice adds nothing.
 */

export const EXAMPLE_TITLE_PREFIX = 'Example: ';

interface ExampleConversation {
  title: string;
  /** Local day and hour of the conversation. */
  day: Civil;
  hour: number;
  user: string;
  reply: string;
  tags: string[];
  entities: string[];
  shortlist?: { quote: string; label: string };
}

const fixedClock = (ms: Ms): Clock => ({ now: () => ms });

function mostRecent(today: Civil, isoDay: number): Civil {
  const back = (isoWeekday(today) - isoDay + 7) % 7 || 7;
  return addDays(today, -back);
}

function lastNovember3(today: Civil): Civil {
  const thisYear = { year: today.year, month: 11, day: 3 };
  const isPast = today.month > 11 || (today.month === 11 && today.day > 3);
  return isPast ? thisYear : { ...thisYear, year: today.year - 1 };
}

function examples(today: Civil): ExampleConversation[] {
  const crm = ['HubSpot', 'Pipedrive', 'Zoho CRM', 'Salesforce', 'Freshsales'];
  return [
    {
      title: `${EXAMPLE_TITLE_PREFIX}CRM shortlist`,
      day: mostRecent(today, 1),
      hour: 9,
      user: "We're choosing a CRM for a 20-person sales team. Our shortlist is HubSpot, Pipedrive, Zoho CRM, Salesforce and Freshsales.",
      reply:
        'Noted: five CRM tools on the shortlist for a 20-person sales team. Ask me to compare them whenever you are ready.',
      tags: ['crm', 'sales team', 'shortlist'],
      entities: crm,
      shortlist: {
        quote: 'Our shortlist is HubSpot, Pipedrive, Zoho CRM, Salesforce and Freshsales',
        label: 'CRM tools',
      },
    },
    {
      title: `${EXAMPLE_TITLE_PREFIX}Neon pricing`,
      day: lastNovember3(today),
      hour: 11,
      user: 'What does Neon charge per month for its Postgres plans?',
      reply:
        'Neon prices its Postgres plans by usage; ask me again and I will check the current numbers.',
      tags: ['neon', 'postgres', 'pricing'],
      entities: ['Neon'],
    },
    {
      title: `${EXAMPLE_TITLE_PREFIX}Postgres hosting`,
      day: mostRecent(today, 2),
      hour: 10,
      user: 'Which managed Postgres host should we use? Compare Neon and Supabase pricing.',
      reply:
        'Neon and Supabase are both managed Postgres hosts; ask me to check their current prices.',
      tags: ['postgres', 'hosting', 'pricing'],
      entities: ['Neon', 'Supabase'],
    },
  ];
}

function plain(text: string): PersistedSentence[] {
  return [{ index: 0, text, template: text, status: 'no_claims', issues: [], placeholders: [] }];
}

export class ExampleHistory {
  constructor(private readonly db: Db) {}

  /** Writes the example conversations unless this user already has them. Returns how many were written. */
  seed(userId: UserId, now: Ms, tz: IanaTz): { created: number } {
    const already = this.db
      .prepare('SELECT 1 FROM conversations WHERE user_id = ? AND title LIKE ? LIMIT 1')
      .get(userId, `${EXAMPLE_TITLE_PREFIX}%`);
    if (already) return { created: 0 };
    const today = localCivil(now, tz);
    const list = examples(today);
    this.db.transaction(() => {
      for (const ex of list) {
        const at = (firstInstantOnOrAfter(ex.day, tz) + ex.hour * 3_600_000);
        const clock = fixedClock(at);
        const conversation = new ConversationRepository(this.db, clock).create({
          userId,
          title: ex.title,
        });
        const messages = new MessageRepository(this.db, clock);
        const asked = messages.insert({
          userId,
          conversationId: conversation.id,
          tz,
          role: 'user',
          content: ex.user,
        });
        const replied = messages.insert({
          userId,
          conversationId: conversation.id,
          tz,
          role: 'assistant',
          content: ex.reply,
          template: ex.reply,
          sentences: plain(ex.reply),
          status: 'complete',
          streamedThrough: 0,
        });
        const directory = new EntityDirectory(this.db, clock, 'live');
        for (const name of ex.entities)
          directory.ensure(userId, { text: name, normalized: normalizeTerm(name) });
        writeEnrichment(
          this.db,
          {
            userId,
            conversationId: conversation.id,
            userMessageId: asked.id,
            assistantMessageId: replied.id,
            now: at,
          },
          parseEnrichment({
            tags: ex.tags.map(normalizeTerm),
            entities: ex.entities.map((text) => ({ text, normalized: normalizeTerm(text) })),
            decisions: ex.shortlist
              ? [
                  {
                    kind: 'shortlist',
                    quote: ex.shortlist.quote,
                    data: { kind: 'shortlist', entities: ex.entities, label: ex.shortlist.label },
                  },
                ]
              : [],
          }),
        );
      }
    })();
    return { created: list.length };
  }
}
