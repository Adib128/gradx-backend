import type {
  MatchableClo,
  MatchableTopic,
} from '../utils/clo-topic-matching.util';

export const MATCH_CLO_TOPICS_PROMPT = `You are an expert in curriculum design and outcome-based education (NCAAA-style course specifications).
Build the CLO–Topic matrix of a course: for every course topic, choose the Course Learning Outcomes (CLOs) that the topic directly contributes to.

Rules:
- Every topic MUST be mapped to at least 1 CLO (usually 1 to 3: the most directly related ones). Never return an empty list.
- Every CLO MUST be covered by at least one topic.
- Use ONLY the CLO codes listed below, copied exactly (e.g. "1.1", "2.3").
- Decide from the meaning of the topic title and the CLO description. Knowledge CLOs usually fit theory/concept topics; skills CLOs fit practical, problem-solving, design or lab topics; values CLOs fit teamwork, ethics, communication, professional practice or project topics.
- Return exactly one entry per topic, using the topic number shown below.

Return ONLY valid JSON in this shape:
{"mappings":[{"topic":1,"clos":["1.1","2.1"]},{"topic":2,"clos":["1.2"]}]}`;

export function buildMatchCloTopicsMessage(
  clos: MatchableClo[],
  topics: MatchableTopic[],
): string {
  const cloLines = clos
    .map((clo) => {
      const category = String(clo.category ?? '').trim();
      const description = String(clo.description ?? '').replace(/\s+/g, ' ').trim();
      return `- ${clo.code}${category ? ` [${category}]` : ''}: ${description || '(no description)'}`;
    })
    .join('\n');
  const topicLines = topics
    .map((topic, index) => `${index + 1}. ${topic.title.replace(/\s+/g, ' ').trim()}`)
    .join('\n');

  return `${MATCH_CLO_TOPICS_PROMPT}

CLOs:
${cloLines}

Topics:
${topicLines}`;
}
