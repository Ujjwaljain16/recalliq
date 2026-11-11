export type Lane = 'chat' | 'recall' | 'research' | 'audit' | 'clarify';
export type Intent = 'pricing' | 'releases' | 'general';

export type TemporalExpression =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'days_ago'; n: number }
  | { kind: 'weekday'; weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; modifier: 'none' | 'last' | 'this' }
  | { kind: 'calendar_date'; day: number; month: number; year?: number }
  | { kind: 'last_week' }
  | { kind: 'since'; anchor: Exclude<TemporalExpression, { kind: 'since' }> };

export interface TemporalMention {
  text: string;
  expr: TemporalExpression;
  role: 'reference_conversation' | 'change_since' | 'event_time';
}

export interface EntityMention {
  text: string;
  normalized: string;
  officialDomainGuess?: string;
}

export interface DecisionPayload {
  kind: 'shortlist' | 'constraint' | 'preference' | 'choice';
  entities?: string[];
  label?: string;
  constraint?: { key: string; value: string | number; unit?: string };
}

export interface UserFact {
  kind: DecisionPayload['kind'] | 'correction';
  quote: string;
  data: DecisionPayload;
  correctsDecisionKind?: DecisionPayload['kind'];
}

export interface TurnAnalysis {
  laneHint: Lane;
  intents: Intent[];
  temporal: TemporalMention[];
  entities: EntityMention[];
  references: Array<{
    text: string;
    kind: 'previous_answer' | 'decision' | 'conversation' | 'entity_set';
  }>;
  topicTerms: string[];
  asksStillCorrect: boolean;
  queries: string[];
  alternateQueries: string[];
  userFacts: UserFact[];
  degraded: boolean;
}
