-- Slide decks are not part of the draft/accept review cycle.
UPDATE "topic_contents"
SET "reviewStatus" = 'ACCEPTED'
WHERE "type" = 'SLIDES';
